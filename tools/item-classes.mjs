/*
 * item-classes — loads tools/item-classes.json, the one map of item classes, and derives
 * what the pipeline needs from it. Edit the JSON, not this file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ITEM_CLASSES = JSON.parse(readFileSync(join(here, 'item-classes.json'), 'utf8'));

export const CLASSES = ITEM_CLASSES.classes;
export const IGNORED = ITEM_CLASSES.ignored || {};

// [slug, token] for every PoE2DB page the scraper reads.
export const PAGES = CLASSES.flatMap((c) => c.pages.map((slug) => [slug, c.token]));

// token → the PoE2DB spawn tags its bases carry, for classes that declare `spawnTags`. A
// class page also lists a sibling class's mods (the Mana Flask page shows life-flask-only
// "Grants #% of Life Recovery to Minions"); the scraper drops a row whose spawn tags name a
// specific tag but none of these.
export const SPAWN_TAGS = new Map(CLASSES.filter((c) => c.spawnTags).map((c) => [c.token, new Set(c.spawnTags)]));

// Canonical token order for `types` arrays.
export const TOKEN_ORDER = CLASSES.map((c) => c.token);

export const ONE_H = new Set(CLASSES.filter((c) => c.hand === '1h').map((c) => c.token));
export const TWO_H = new Set(CLASSES.filter((c) => c.hand === '2h').map((c) => c.token));
