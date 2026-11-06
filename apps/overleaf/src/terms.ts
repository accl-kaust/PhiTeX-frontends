// The terms the extension asks for once, before anything of its own is done:
// ⚡ Instant's first use, or the first folder (which makes a project in the
// user's account). It is unofficial and experimental, provided as is. One
// acceptance for both (chrome.storage's `accepted`: this version of them),
// withdrawn in the popup for both. No imports: the dashboard's page script
// bundles it, the content scripts and the popup load it.

/** The terms' version: bump it to ask again. */
export const TERMS = 1;

/** What the user ticks. */
export const AGREE = "I understand this is an unofficial, experimental extension, provided as is, without any warranty, and I use it at my own risk.";

/** The licence and the warranty, as the dialogs say them (markup; `license`: the full licence's address). */
export const asIs = (license: string) =>
  `Free software under the GNU AGPL, version 3 only (<a href="${license}" target="_blank" rel="noopener">full license</a>), provided as is, without any warranty (its sections 15 and 16). The authors bear no responsibility for its use.`;
