// The licence and the notice this program is distributed under, inside the
// binary itself.
//
// The upstream licence is MIT, which asks that its copyright and permission
// notice go with every copy. A copy of this program is one file: the release
// archives, the installers and the package managers all end with a single
// binary on a PATH, and the self updater replaces that file and nothing else.
// So the text is compiled in from the repository's own LICENSE and NOTICE, and
// `rafikicode licenses` prints it. The channels also deliver the two files
// beside the binary where they have somewhere to put them (docs/install.md).
import LICENSE from "../../../../LICENSE" with { type: "text" }
import NOTICE from "../../../../NOTICE" with { type: "text" }

export const license: string = LICENSE
export const notice: string = NOTICE

export function text() {
  return `${notice.trimEnd()}\n\n${license.trimEnd()}\n`
}

export * as Licence from "./licence"
