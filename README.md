# HarvestHive Security

This repo exists so anyone — especially the Bitcoin/NOSTR community, whose trust HarvestHive depends on — can independently verify two specific claims about how HarvestHive handles keys and identity, without needing access to the full (private) application codebase.

**The claims:**

1. Your NOSTR private key (nsec) is never transmitted to or stored on any HarvestHive server. It is encrypted and stored only on your own device.
2. HarvestHive's core data — listings, profiles, follows, direct messages — is built on standard, open NOSTR events, not a proprietary format you're locked into.

This repo contains the exact source for the two files that make claim 1 true, and a full breakdown of the NOSTR event structure that makes claim 2 true. It is a curated mirror, not the full app — HarvestHive's main repository stays private (it contains a lot of product code that isn't relevant to security, and some of it we'd rather competitors didn't get for free). What's here is everything relevant to "can I trust this app with my key," kept in sync with what's actually running in production.

If you find a discrepancy between what's here and what the live app actually does, please open an issue — that's the entire point of this repo existing.

---

## What's in here

- [`keystore.ts`](./keystore.ts) — how your private key is encrypted at rest
- [`session.ts`](./session.ts) — how your private key is handled in memory during a session
- [`nostr-events.md`](./nostr-events.md) — every NOSTR event kind HarvestHive reads or writes, standard and custom

---

## Key storage — `keystore.ts`

When you create a HarvestHive account (or import an existing NOSTR identity), your private key is encrypted before it ever touches disk:

- **AES-256-GCM** for the encryption itself — the current standard for authenticated symmetric encryption.
- **PBKDF2 with 310,000 iterations** (SHA-256) to derive the encryption key from your password — in line with [OWASP's 2023 minimum recommendation](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pbkdf2), making brute-force password guessing computationally expensive.
- **A fresh random salt and IV on every encryption** — the same password never produces the same ciphertext twice.
- **The Web Crypto API**, native to the browser — no third-party crypto library in the trust chain.
- **A wrong password fails silently** (returns `null`) rather than leaking any information about *why* it failed.

The encrypted blob is stored in `localStorage`, scoped to your browser/device. It never leaves your device as part of this flow — HarvestHive's servers only ever see your public key (npub), which is, by design, public information on the NOSTR network regardless of what app you use.

**One honest caveat:** if you choose not to set a password (no backup configured), the key is stored *unencrypted* — see `storePrivateKeyUnencrypted()` / `retrievePrivateKeyUnencrypted()` in the file. This is a deliberate launch-time tradeoff, not an oversight — the app shows a clear warning recommending you set a backup password. If you're relying on this repo to decide how much to trust your key storage, set a password.

**Note on reading the code:** `keystore.ts` is copied byte-for-byte from the live app, including its import of `activeConfig` from the app's internal config module (used only to prefix the `localStorage` key with the current community tag). That import won't resolve if you try to compile this file standalone — it isn't meant to run outside the app, only to be read and compared against what's actually deployed.

## Session handling — `session.ts`

Asking you to re-enter your password before every single action would make the app unusable. Instead:

- Your decrypted key lives in memory only, for the duration of your session — never written to `localStorage` or anywhere else.
- It's cleared automatically when you close the tab (`beforeunload`), and the underlying memory is explicitly zeroed out rather than just dereferenced.
- Every new session requires your password again to decrypt the key back into memory.

Net effect: at rest, your key exists only as ciphertext on your device. In use, it exists only in your browser's memory, for as long as the tab is open. At no point does it exist on a HarvestHive server, in a HarvestHive database, or in transit to one.

---

## NOSTR event structure

HarvestHive is built on real NOSTR events published to a relay — not a proprietary backend pretending to be decentralized. Full breakdown in [`nostr-events.md`](./nostr-events.md); summary below.

| Kind | Purpose | Standard |
|---|---|---|
| 0 | Profile metadata (name, avatar, bio, Lightning address) | [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) |
| 3 | Follows / contact list | [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) |
| 13 / 14 / 1059 | Encrypted direct messages | [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) |
| 1984 | Reports (moderation) | [NIP-56](https://github.com/nostr-protocol/nips/blob/master/56.md) |
| 9734 / 9735 | Lightning zaps | [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) |
| 30100 | HarvestHive listing (custom) | Addressable event, [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md#kinds) |
| 30101 | HarvestHive profile extension (custom) | Addressable event, [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md#kinds) |

**On the two custom kinds (30100, 30101):** these aren't a departure from the protocol — they use the standard addressable-event range (30000–39999, formerly its own NIP-33, since folded into NIP-01) that any NOSTR app can use for app-specific data. A listing is a signed event with a `d` tag as its unique identifier; publishing a new event with the same `d` tag replaces the old one, which is how editing and delisting work. Any NOSTR client, not just HarvestHive's, can read these events off the relay — they're just tagged `t: harvesthive` so our indexer (and anyone else's) can filter them out of general relay traffic.

**On direct messages:** HarvestHive uses NIP-17, not the older/deprecated NIP-04. A message is created as an unsigned kind 14 event, sealed (signed, encrypted to the recipient) as kind 13, then gift-wrapped and re-signed by a disposable one-time key as kind 1059 before being published. The outer layer's throwaway signing key means relays — including our own — can't even see who's talking to whom, only that *someone* received a wrapped message. Both the seal and the gift wrap use [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) encryption.

**On what's deliberately *not* on the relay:** saved searches are stored in Supabase only, never published as NOSTR events. That's a privacy choice, not a technical limitation — a saved search (your postcode, radius, category preferences) is intent data we don't think relay operators need visibility into, even in encrypted form. It also means a relay compromise can't reconstruct anyone's search history, since it was never there to begin with.

---

## Standard NIPs this app relies on

- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) — base protocol, event structure, addressable events
- [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) — follow lists
- [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) — event deletion
- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) — private direct messages
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) — encryption algorithm used by NIP-17
- [NIP-56](https://github.com/nostr-protocol/nips/blob/master/56.md) — reporting
- [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) — Lightning zaps
- [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) — gift wrap, underlying NIP-17's sender privacy

NIP-07 (browser extension signing) is on the roadmap but not yet supported — for now, HarvestHive generates and manages your key as described above rather than delegating to an extension like Alby or nos2x.

---

## What this repo doesn't cover

This isn't a full security audit, and it isn't a claim that HarvestHive is bug-free. It covers exactly the two things stated at the top: key custody and event structure. Server-side code (Supabase RLS policies, Edge Functions, the relay itself) lives in the private main repo, because most of it is product logic rather than anything you need to trust with your key. If that changes — if we ever want to make a stronger, broader claim — this repo will grow to match it.

## Questions or found a problem?

Open an issue on this repo, or reach us at hello@harvesthive.app.
