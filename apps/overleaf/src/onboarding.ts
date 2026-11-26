// What the extension points out, and when: the rules, apart from the DOM
// (content-main.ts draws them; test/unit/onboarding.test.ts checks them).
//
// - A fresh install sees no What's new and nothing called "New": everything
//   is new to it. Its first visit has the welcome (the terms in it, one
//   step) and, once ⚡ Instant is on, the short tour.
// - What's new is for an update only: the notes newer than the version last
//   seen. Its "Got it" leads to the tips of the features it announced.
// - One card a visit: the welcome, What's new (then its tips), the tour, or
//   one feature tip. Never two at once.
// - A step or tip whose control is hidden at this width is skipped.

import { NEWS, compareVersions, unseen, type News } from "./news.ts";

/** What chrome.storage holds about it. */
export type Seen = { newsSeen?: string | null; installed?: string | null; tipsSeen?: string[] | null };

/**
 * The storage an install or update writes (chrome.runtime.onInstalled):
 * an install counts this version's notes as seen and is "installed" at it;
 * an update that never recorded notes seen (installed before What's new)
 * counts the version it came from as seen.
 */
export function installWrites(reason: string, version: string, previous: string | undefined, stored: Seen): Record<string, string> {
  if (reason === "install") return { newsSeen: version, installed: version };
  if (reason === "update" && !stored.newsSeen) return { newsSeen: previous ?? version };
  return {};
}

/**
 * The notes to show on this load, and what to store. Notes seen at no
 * version (a storage cleared, a browser whose install event never came):
 * a fresh install, so none, and this version counted as seen.
 */
export function newsNow(stored: Seen, current: string, news: News[] = NEWS): { items: News[]; write: Record<string, string> | null } {
  if (!stored.newsSeen) return { items: [], write: { newsSeen: current, ...(stored.installed ? {} : { installed: current }) } };
  return { items: unseen(stored.newsSeen, current, news), write: null };
}

/** A feature tip: `since`, the version that brought the feature ("New" to whoever had installed before it). */
export type Tip = { id: string; since?: string };

/** "New" to this user: the feature came after the version they installed (unknown: before What's new, so an old user). */
export function isNewFor(tip: Tip, installed: string | null | undefined): boolean {
  return !!tip.since && (!installed || compareVersions(tip.since, installed) > 0);
}

/**
 * The tips to show now, in order:
 * - "news": after What's new's "Got it", the features its notes announced
 *   (`since` newer than `newsBefore`, the version seen before them), not
 *   seen yet; every new one when `all` (What's new asked for again);
 * - "one": a visit's single tip, the first not seen.
 * `shown`: whether its control is on screen now (hidden ones are skipped).
 */
export function tipsNow<T extends Tip>(tips: T[], kind: "news" | "one", s: { seen: string[]; installed?: string | null; newsBefore?: string | null; all?: boolean }, shown: (t: T) => boolean): T[] {
  const seen = new Set(s.all ? [] : s.seen);
  const left = tips.filter((t) => !seen.has(t.id) && shown(t));
  if (kind === "one") return left.slice(0, 1);
  return left.filter((t) => t.since && isNewFor(t, s.installed) && (s.all || !s.newsBefore || compareVersions(t.since, s.newsBefore) > 0));
}

/** An element on screen: laid out, with a size, inside the window (a control a narrow toolbar hid is not). */
export function onScreen(el: Element | null | undefined): el is Element {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
}
