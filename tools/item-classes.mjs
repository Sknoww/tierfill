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

// Canonical token order for `types` arrays.
export const TOKEN_ORDER = CLASSES.map((c) => c.token);

export const ONE_H = new Set(CLASSES.filter((c) => c.hand === '1h').map((c) => c.token));
export const TWO_H = new Set(CLASSES.filter((c) => c.hand === '2h').map((c) => c.token));
