# NOSTR Event Structure

Full detail on every NOSTR event kind HarvestHive reads or writes — standard and custom — referenced from the [README](./README.md). If you just want the summary table, it's there; this is the detail behind it.

---

## Background: how NOSTR events work

Everything in NOSTR is a signed JSON event. Every event, regardless of kind, has the same base shape:

```json
{
  "id": "<derived hash of the event content>",
  "pubkey": "<author's public key>",
  "created_at": 1234567890,
  "kind": 1,
  "tags": [],
  "content": "the main content string",
  "sig": "<cryptographic signature>"
}
```

`kind` is the number that defines the event type and how clients should interpret it. `tags` is an array of arrays — structured metadata attached to the event (this is how a listing's postcode, category, price, etc. get attached in a way relays can index and filter on).

Kinds 30000–39999 are **addressable events** (formerly their own NIP-33, since folded into [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md#kinds)): an event in this range can be updated by publishing a new event with the same `kind` + `pubkey` + `d` tag combination, and relays are expected to keep only the latest version. This is the mechanism HarvestHive listings use — it's how editing and delisting work, and it's a standard, protocol-level feature, not something custom to this app.

---

## HarvestHive event kinds

| Kind | Purpose | Standard |
|---|---|---|
| 0 | Profile metadata — name, avatar, bio, Lightning address | [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) |
| 3 | Contact list / follows | [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) |
| 13 | Seal (inner encryption layer for DMs) | [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) |
| 14 | Encrypted DM content (unsigned rumor) | [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) |
| 1059 | Gift-wrapped DM (outer layer, disposable signing key) | [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) |
| 1984 | Report | [NIP-56](https://github.com/nostr-protocol/nips/blob/master/56.md) |
| 9734 / 9735 | Zap request / zap receipt | [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) |
| 30100 | HarvestHive Listing — custom, addressable | [NIP-01 addressable events](https://github.com/nostr-protocol/nips/blob/master/01.md#kinds) |
| 30101 | HarvestHive Profile Extension — custom, addressable | [NIP-01 addressable events](https://github.com/nostr-protocol/nips/blob/master/01.md#kinds) |

Note: saved searches are **not** published as NOSTR events at all — see the note at the bottom of this doc.

---

## Kind 30100: Listing event

Every listing a grower publishes is a kind 30100 event, signed with their own private key, broadcast to the relay:

```json
{
  "kind": 30100,
  "pubkey": "<grower's public key>",
  "created_at": 1234567890,
  "tags": [
    ["d", "<unique listing id — uuid generated client-side>"],
    ["title", "Backyard Eggs — free range"],
    ["category", "eggs"],
    ["listing_type", "sale"],
    ["payment", "both"],
    ["price", "4.00"],
    ["price_unit", "dozen"],
    ["postcode", "5068"],
    ["swap_description", "happy to swap for veg or seedlings"],
    ["status", "active"],
    ["expiry", "1234567890"],
    ["image", "https://media.harvesthive.app/image1.jpg"],
    ["image", "https://media.harvesthive.app/image2.jpg"],
    ["t", "harvesthive"],
    ["t", "harvesthive-listing"]
  ],
  "content": "Our hens free range on a quarter acre in Norwood.",
  "id": "<derived>",
  "sig": "<derived>"
}
```

**Key fields:**
- `d` — the unique listing identifier. Publishing a new event with the same `d` value replaces the old one on the relay — this is how editing works.
- `category` — one of: fruit / vegetables / eggs / honey / seeds-seedlings / jams-preserves / pickled-fermented / frozen / other.
- `listing_type` — sale / swap / both.
- `payment` — cash / lightning / both.
- `status` — active / sold / expired. Marking a listing sold means publishing a replacement event with `status: sold`.
- `expiry` — Unix timestamp, omitted entirely if the listing has no expiry.
- `image` — one tag per photo, in gallery order.
- `t` — always includes `harvesthive` and `harvesthive-listing`, so our indexer (or anyone else's) can filter HarvestHive events out of general relay traffic.

**Editing:** grower changes a field → client builds a new kind 30100 event with the same `d` tag and updated fields → signs it → broadcasts it → relay replaces the old event → our indexer picks up the change.

**Marking sold:** client publishes a replacement event with `status: sold` → indexer removes it from the search index → listing disappears from search results. The original event isn't deleted, just superseded.

**Expiry:** handled entirely on our indexing side — a scheduled job checks for passed `expiry` timestamps and removes expired listings from the search index. The underlying NOSTR event itself isn't touched.

---

## Kind 30101: Profile extension event

NOSTR's standard kind 0 covers basic profile data (name, avatar, bio, Lightning address). Kind 30101 extends it with HarvestHive-specific fields, without polluting a user's global NOSTR profile with app-specific data other clients wouldn't know what to do with:

```json
{
  "kind": 30101,
  "pubkey": "<user's public key>",
  "created_at": 1234567890,
  "tags": [
    ["d", "harvesthive-profile"],
    ["postcode", "5068"],
    ["member_since", "1234567890"],
    ["t", "harvesthive"],
    ["t", "harvesthive-listing"]
  ],
  "content": "",
  "id": "<derived>",
  "sig": "<derived>"
}
```

The `d` tag is always the fixed string `harvesthive-profile` — a user only ever has one of these, and publishing a new one replaces the old.

---

## Kind 1984: Reports

Standard [NIP-56](https://github.com/nostr-protocol/nips/blob/master/56.md) reporting — nothing custom here. Report events tagged `harvesthive` are picked up by our indexer and routed into the moderation queue.

## Follows (kind 3)

Standard NOSTR contact-list events. When you follow a grower, your client publishes an updated kind 3 event containing their pubkey. Our indexer watches these for HarvestHive users to power "new listing from someone you follow" notifications — the follow relationship itself is fully portable, not locked to this app.

## Encrypted DMs (NIP-17)

A message starts as an unsigned kind 14 event (the actual content), gets sealed as a signed kind 13 event encrypted to the recipient, then gift-wrapped as a kind 1059 event signed by a one-time disposable key before being published. That outer disposable key is what prevents relays — including ours — from seeing who's actually talking to whom; they can see that *a* wrapped message exists, not its sender. All of this is handled by standard NOSTR tooling (`nostr-tools`), not custom crypto. The one HarvestHive-specific addition is that the first message in a thread references the relevant listing's `d` tag, so the app can show listing context at the top of the conversation.

## Saved searches — deliberately not on the relay

Saved searches (postcode, radius, category preferences) are stored in Supabase only and never published as a NOSTR event of any kind. This is a deliberate privacy decision: a saved search is personal intent data that we don't think relay operators — including community-run ones — need visibility into, even encrypted. It also means there's nothing to leak from a relay compromise, because it was never published there in the first place.
