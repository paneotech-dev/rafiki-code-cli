#!/usr/bin/env bun
// The macOS builds are cross compiled on a Linux runner, and the compiler
// leaves a signature that does not match the file: 0.1.9 shipped darwin-arm64
// with its last page hash computed over a zero padded page, and darwin-x64 with
// the Developer ID signature of the Bun runtime, which covers less than half of
// the file. macOS checks page hashes when it maps code, and Apple Silicon does
// not run code without a valid signature.
//
// So every darwin binary is signed ad hoc once it is final, and the result is
// checked here, page by page, before it is started, hashed or packed:
//
//   signMacOSBinary(file)   codesign on a Mac, rcodesign elsewhere, then the check
//   checkAdhocSignature()   the check alone, on the bytes of a thin Mach-O
//
// As a script it checks the files it is given and exits 1 if any is not valid:
//
//   bun packages/opencode/script/macos-signature.ts <binary>...
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const MH_MAGIC_64 = 0xfeedfacf
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0
const CSMAGIC_CODEDIRECTORY = 0xfade0c02
const CSMAGIC_BLOBWRAPPER = 0xfade0b01
const CSSLOT_CODEDIRECTORY = 0
const CSSLOT_ALTERNATE_FIRST = 0x1000
const CSSLOT_ALTERNATE_LAST = 0x1004
const CSSLOT_SIGNATURESLOT = 0x10000
const CS_ADHOC = 0x2
const CS_HASHTYPE_SHA1 = 1
const CS_HASHTYPE_SHA256 = 2

export type SignatureSummary = {
  identifier: string
  flags: number
  pages: number
  codeLimit: number
  fileSize: number
}

export type SignatureCheck = { problems: string[]; summary?: SignatureSummary }

const algorithm = (hashType: number) =>
  hashType === CS_HASHTYPE_SHA256 ? "sha256" : hashType === CS_HASHTYPE_SHA1 ? "sha1" : undefined

const digest = (name: string, data: Uint8Array, size: number) =>
  createHash(name).update(data).digest().subarray(0, size)

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i])

const cString = (bytes: Uint8Array, start: number) => {
  let end = start
  while (end < bytes.length && bytes[end] !== 0) end++
  return new TextDecoder().decode(bytes.subarray(start, end))
}

// What Apple's codesign accepts for a single architecture executable signed ad
// hoc: the signature is the last thing in the file and inside __LINKEDIT, every
// CodeDirectory covers every byte before it, each page hash and each special
// slot hash is right, and there is no certificate.
export function checkAdhocSignature(bytes: Uint8Array): SignatureCheck {
  const problems: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 32 || view.getUint32(0, true) !== MH_MAGIC_64) {
    return { problems: ["not a thin 64-bit Mach-O file"] }
  }

  const ncmds = view.getUint32(16, true)
  const sizeofcmds = view.getUint32(20, true)
  if (32 + sizeofcmds > bytes.length) return { problems: ["load commands run past the end of the file"] }
  let signature: { offset: number; size: number } | undefined
  let linkedit: { offset: number; size: number } | undefined
  for (let i = 0, at = 32; i < ncmds; i++) {
    if (at + 8 > 32 + sizeofcmds) return { problems: ["load commands are truncated"] }
    const cmd = view.getUint32(at, true)
    const cmdsize = view.getUint32(at + 4, true)
    if (cmdsize < 8) return { problems: [`load command ${i} has size ${cmdsize}`] }
    if (cmd === LC_CODE_SIGNATURE) {
      signature = { offset: view.getUint32(at + 8, true), size: view.getUint32(at + 12, true) }
    }
    if (cmd === LC_SEGMENT_64 && cString(bytes.subarray(at + 8, at + 24), 0) === "__LINKEDIT") {
      linkedit = { offset: Number(view.getBigUint64(at + 40, true)), size: Number(view.getBigUint64(at + 48, true)) }
    }
    at += cmdsize
  }
  if (!signature) return { problems: ["no code signature"] }
  if (signature.offset + signature.size !== bytes.length) {
    problems.push(
      `the signature (offset ${signature.offset}, ${signature.size} bytes) does not end the file (${bytes.length} bytes)`,
    )
  }
  if (!linkedit || signature.offset < linkedit.offset || signature.offset + signature.size > linkedit.offset + linkedit.size) {
    problems.push("the signature is not inside __LINKEDIT")
  }
  if (signature.offset + 12 > bytes.length) return { problems: [...problems, "the signature lies outside the file"] }

  const superBlob = signature.offset
  if (view.getUint32(superBlob) !== CSMAGIC_EMBEDDED_SIGNATURE) {
    return { problems: [...problems, "the signature is not an embedded signature blob"] }
  }
  const count = view.getUint32(superBlob + 8)
  const blobs = new Map<number, Uint8Array>()
  for (let i = 0; i < count; i++) {
    const type = view.getUint32(superBlob + 12 + 8 * i)
    const start = superBlob + view.getUint32(superBlob + 16 + 8 * i)
    if (start + 8 > bytes.length) return { problems: [...problems, `signature blob ${type} lies outside the file`] }
    const length = view.getUint32(start + 4)
    if (start + length > bytes.length) return { problems: [...problems, `signature blob ${type} runs past the file`] }
    blobs.set(type, bytes.subarray(start, start + length))
  }

  const cms = blobs.get(CSSLOT_SIGNATURESLOT)
  if (cms && (new DataView(cms.buffer, cms.byteOffset).getUint32(0) !== CSMAGIC_BLOBWRAPPER || cms.length > 8)) {
    problems.push("the signature carries a certificate signature: it is not ad hoc")
  }

  const directories = [...blobs.entries()].filter(
    ([type]) => type === CSSLOT_CODEDIRECTORY || (type >= CSSLOT_ALTERNATE_FIRST && type <= CSSLOT_ALTERNATE_LAST),
  )
  if (!directories.some(([type]) => type === CSSLOT_CODEDIRECTORY)) {
    return { problems: [...problems, "the signature has no code directory"] }
  }

  let summary: SignatureSummary | undefined
  let sha256 = false
  for (const [slot, cd] of directories) {
    const label = slot === CSSLOT_CODEDIRECTORY ? "code directory" : `alternate code directory ${slot}`
    const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
    if (cd.length < 44 || cdv.getUint32(0) !== CSMAGIC_CODEDIRECTORY) {
      problems.push(`${label}: not a code directory`)
      continue
    }
    const version = cdv.getUint32(8)
    const flags = cdv.getUint32(12)
    const hashOffset = cdv.getUint32(16)
    const identOffset = cdv.getUint32(20)
    const nSpecialSlots = cdv.getUint32(24)
    const nCodeSlots = cdv.getUint32(28)
    let codeLimit = cdv.getUint32(32)
    const hashSize = cdv.getUint8(36)
    const hashType = cdv.getUint8(37)
    const pageShift = cdv.getUint8(39)
    if (version >= 0x20300 && cd.length >= 64) {
      const limit64 = Number(cdv.getBigUint64(56))
      if (limit64) codeLimit = limit64
    }
    const name = algorithm(hashType)
    if (!name) {
      problems.push(`${label}: unknown hash type ${hashType}`)
      continue
    }
    if (hashType === CS_HASHTYPE_SHA256) sha256 = true
    if ((flags & CS_ADHOC) === 0) problems.push(`${label}: flags 0x${flags.toString(16)} do not include ad hoc`)
    if (version >= 0x20200 && cd.length >= 52 && cdv.getUint32(48) !== 0) {
      problems.push(`${label}: names a team (${cString(cd, cdv.getUint32(48))}): it is not ad hoc`)
    }
    if (codeLimit !== signature.offset) {
      problems.push(`${label}: covers ${codeLimit} bytes, but the signature starts at ${signature.offset}`)
    }
    if (pageShift < 12 || pageShift > 16) {
      problems.push(`${label}: page size 2^${pageShift} is not one macOS uses`)
      continue
    }
    const pageSize = 2 ** pageShift
    const expected = Math.ceil(codeLimit / pageSize)
    if (nCodeSlots !== expected) problems.push(`${label}: ${nCodeSlots} page hashes for ${expected} pages`)
    if (hashOffset + nCodeSlots * hashSize > cd.length || hashOffset < nSpecialSlots * hashSize) {
      problems.push(`${label}: hash table runs outside the code directory`)
      continue
    }

    const wrong: number[] = []
    for (let page = 0; page < nCodeSlots; page++) {
      const start = page * pageSize
      const data = bytes.subarray(start, Math.min(start + pageSize, codeLimit))
      const recorded = cd.subarray(hashOffset + page * hashSize, hashOffset + (page + 1) * hashSize)
      if (!same(digest(name, data, hashSize), recorded)) wrong.push(page)
    }
    if (wrong.length) {
      const shown = wrong.length > 6 ? [...wrong.slice(0, 3), "...", ...wrong.slice(-3)] : wrong
      problems.push(`${label}: ${wrong.length} of ${nCodeSlots} page hashes do not match (pages ${shown.join(", ")})`)
    }

    // Special slots count down from the hash table: slot n is n hashes before it.
    for (let special = 1; special <= nSpecialSlots; special++) {
      const at = hashOffset - special * hashSize
      const recorded = cd.subarray(at, at + hashSize)
      const blob = blobs.get(special)
      const empty = recorded.every((value) => value === 0)
      if (blob ? !same(digest(name, blob, hashSize), recorded) : !empty) {
        problems.push(`${label}: the hash of special slot ${special} does not match`)
      }
    }

    if (slot === CSSLOT_CODEDIRECTORY) {
      summary = {
        identifier: cString(cd, identOffset),
        flags,
        pages: nCodeSlots,
        codeLimit,
        fileSize: bytes.length,
      }
    }
  }
  if (!sha256) problems.push("no code directory uses SHA-256")
  return { problems, summary }
}

export function checkFile(file: string): SignatureCheck {
  return checkAdhocSignature(readFileSync(file))
}

export function describeCheck(file: string, result: SignatureCheck) {
  if (result.problems.length) return result.problems.map((problem) => `${file}: ${problem}`).join("\n")
  const s = result.summary!
  return (
    `${file}: valid ad hoc signature, identifier ${s.identifier}, flags 0x${s.flags.toString(16)}, ` +
    `all ${s.pages} page hashes match, covers ${s.codeLimit} of ${s.fileSize} bytes`
  )
}

type SignOptions = {
  identifier: string
  // The release sets RAFIKICODE_REQUIRE_MACOS_SIGNATURE=1: a build that cannot
  // sign, or whose signature does not check out, stops there.
  required: boolean
  platform?: string
  rcodesign?: string | null
}

// Signs one darwin binary ad hoc, in place, and checks it. Throws when the
// result is not valid, or when no signer exists and a signature is required.
// Returns how it was signed, or undefined when it was left as the compiler
// wrote it (a local build on Linux without rcodesign).
export async function signMacOSBinary(file: string, options: SignOptions) {
  const platform = options.platform ?? process.platform
  const rcodesign = options.rcodesign === undefined ? Bun.which("rcodesign") : options.rcodesign
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) {
      throw new Error(`${command.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`)
    }
  }
  let signer: string | undefined
  if (platform === "darwin") {
    run(["codesign", "--force", "--sign", "-", file])
    signer = "codesign"
  } else if (rcodesign) {
    run([rcodesign, "sign", "--binary-identifier", options.identifier, file])
    signer = "rcodesign"
  } else if (options.required) {
    throw new Error(
      `${file} cannot be signed: this is not a Mac and rcodesign is not on PATH (RAFIKICODE_REQUIRE_MACOS_SIGNATURE=1)`,
    )
  } else {
    console.log(`Not signed: ${file} (not a Mac and no rcodesign on PATH; a release build requires it)`)
    return undefined
  }
  const result = checkFile(file)
  if (result.problems.length) throw new Error(`signed with ${signer}, but the signature is not valid:\n${describeCheck(file, result)}`)
  console.log(describeCheck(file, result))
  return signer
}

if (import.meta.main) {
  const files = process.argv.slice(2)
  if (!files.length) {
    console.error("usage: bun packages/opencode/script/macos-signature.ts <binary>...")
    process.exit(2)
  }
  let failed = false
  for (const file of files) {
    const result = checkFile(file)
    console.log(describeCheck(file, result))
    if (result.problems.length) failed = true
  }
  process.exit(failed ? 1 : 0)
}
