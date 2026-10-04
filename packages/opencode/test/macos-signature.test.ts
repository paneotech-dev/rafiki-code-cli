// The check that stops a release when a macOS build's signature is not valid.
// The defects are the two the 0.1.9 archives shipped with: darwin-arm64 had its
// last, partial page hashed as if padded with zeros, and darwin-x64 carried a
// Developer ID signature that covered only the start of the file.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { checkAdhocSignature, describeCheck, signMacOSBinary } from "../script/macos-signature.ts"

const PAGE = 4096

type Fault = {
  padLastPage?: boolean
  coverOnly?: number
  flags?: number
  team?: string
  certificate?: boolean
  trailing?: number
  sha1?: boolean
}

const be32 = (value: number) => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const hash = (data: Uint8Array, sha1 = false) =>
  new Uint8Array(createHash(sha1 ? "sha1" : "sha256").update(data).digest())

// A thin x86_64 executable of 3 pages and 1,000 bytes, signed the way codesign
// signs it ad hoc, unless a fault is asked for.
function machO(fault: Fault = {}) {
  const codeLimit = 3 * PAGE + 1000
  const code = new Uint8Array(codeLimit)
  for (let i = 0; i < code.length; i++) code[i] = (i * 7 + 3) & 0xff
  const header = new DataView(code.buffer)
  header.setUint32(0, 0xfeedfacf, true)
  header.setUint32(4, 0x01000007, true)
  header.setUint32(12, 2, true) // MH_EXECUTE
  header.setUint32(16, 2, true) // ncmds
  header.setUint32(20, 72 + 16, true) // sizeofcmds
  // LC_SEGMENT_64 __LINKEDIT, from the second page to the end of the file.
  header.setUint32(32, 0x19, true)
  header.setUint32(36, 72, true)
  code.fill(0, 40, 56)
  new TextEncoder().encodeInto("__LINKEDIT", code.subarray(40, 56))

  const requirements = concat(be32(0xfade0c01), be32(12), be32(0))
  const cms = fault.certificate
    ? concat(be32(0xfade0b01), be32(8 + 16), new Uint8Array(16).fill(0x30))
    : concat(be32(0xfade0b01), be32(8))

  const pageCount = Math.ceil(codeLimit / PAGE)
  const limit = fault.coverOnly ?? codeLimit
  const covered = Math.ceil(limit / PAGE)
  const hashSize = fault.sha1 ? 20 : 32

  // The signature's size depends only on counts, so it can be laid out first
  // and the header filled in before any page is hashed.
  const identifier = new TextEncoder().encode("rafikicode\0")
  const team = fault.team ? new TextEncoder().encode(`${fault.team}\0`) : new Uint8Array(0)
  const nSpecial = 2
  const fixed = 88
  const identOffset = fixed
  const teamOffset = fault.team ? identOffset + identifier.length : 0
  const hashOffset = fixed + identifier.length + team.length + nSpecial * hashSize
  const cdLength = hashOffset + covered * hashSize
  const superLength = 12 + 3 * 8 + cdLength + requirements.length + cms.length
  const trailing = fault.trailing ?? 0

  header.setUint32(32 + 72, 0x1d, true)
  header.setUint32(32 + 76, 16, true)
  header.setUint32(32 + 80, codeLimit, true)
  header.setUint32(32 + 84, superLength, true)
  header.setBigUint64(32 + 40, BigInt(PAGE), true) // fileoff
  header.setBigUint64(32 + 48, BigInt(codeLimit + superLength + trailing - PAGE), true) // filesize

  const pageHashes = Array.from({ length: covered }, (_, i) => {
    const start = i * PAGE
    let page = code.subarray(start, Math.min(start + PAGE, limit))
    if (fault.padLastPage && page.length < PAGE) page = concat(page, new Uint8Array(PAGE - page.length))
    return hash(page, fault.sha1).subarray(0, hashSize)
  })
  const special = [hash(requirements, fault.sha1).subarray(0, hashSize), new Uint8Array(hashSize)] // slot 2, slot 1

  const cd = new Uint8Array(cdLength)
  const v = new DataView(cd.buffer)
  v.setUint32(0, 0xfade0c02)
  v.setUint32(4, cdLength)
  v.setUint32(8, 0x20400)
  v.setUint32(12, fault.flags ?? 0x2)
  v.setUint32(16, hashOffset)
  v.setUint32(20, identOffset)
  v.setUint32(24, nSpecial)
  v.setUint32(28, covered)
  v.setUint32(32, limit)
  v.setUint8(36, hashSize)
  v.setUint8(37, fault.sha1 ? 1 : 2)
  v.setUint8(39, 12)
  v.setUint32(48, teamOffset)
  cd.set(identifier, identOffset)
  if (fault.team) cd.set(team, teamOffset)
  // Slot 2 sits two hashes before the table, slot 1 one hash before it.
  cd.set(special[0], hashOffset - 2 * hashSize)
  cd.set(special[1], hashOffset - 1 * hashSize)
  pageHashes.forEach((h, i) => cd.set(h, hashOffset + i * hashSize))

  const index = 12 + 3 * 8
  const superBlob = concat(
    be32(0xfade0cc0),
    be32(superLength),
    be32(3),
    be32(0),
    be32(index),
    be32(2),
    be32(index + cdLength),
    be32(0x10000),
    be32(index + cdLength + requirements.length),
    cd,
    requirements,
    cms,
  )
  expect(pageCount).toBe(4)
  return concat(code, superBlob, new Uint8Array(trailing))
}

describe("checkAdhocSignature", () => {
  test("accepts a correct ad hoc signature", () => {
    const result = checkAdhocSignature(machO())
    expect(result.problems).toEqual([])
    expect(result.summary).toEqual({
      identifier: "rafikicode",
      flags: 0x2,
      pages: 4,
      codeLimit: 3 * PAGE + 1000,
      fileSize: machO().length,
    })
    expect(describeCheck("bin", result)).toContain("valid ad hoc signature, identifier rafikicode")
  })

  test("refuses a last page hashed as if padded with zeros (darwin-arm64 in 0.1.9)", () => {
    const { problems } = checkAdhocSignature(machO({ padLastPage: true }))
    expect(problems).toEqual(["code directory: 1 of 4 page hashes do not match (pages 3)"])
  })

  test("refuses a signature that covers only the start of the file (darwin-x64 in 0.1.9)", () => {
    const { problems } = checkAdhocSignature(machO({ coverOnly: 2 * PAGE, flags: 0x10000, team: "7FRXF46ZSN", certificate: true }))
    expect(problems).toContain("the signature carries a certificate signature: it is not ad hoc")
    expect(problems).toContain("code directory: flags 0x10000 do not include ad hoc")
    expect(problems).toContain("code directory: names a team (7FRXF46ZSN): it is not ad hoc")
    expect(problems).toContain(`code directory: covers ${2 * PAGE} bytes, but the signature starts at ${3 * PAGE + 1000}`)
  })

  test("refuses a byte changed after signing", () => {
    const bytes = machO()
    bytes[PAGE + 5] ^= 0xff
    expect(checkAdhocSignature(bytes).problems).toEqual(["code directory: 1 of 4 page hashes do not match (pages 1)"])
  })

  test("refuses a changed requirements blob", () => {
    const bytes = machO()
    // The requirements blob's count field, the last word before the CMS wrapper.
    const at = bytes.length - 8 - 4
    bytes[at + 3] = 1
    expect(checkAdhocSignature(bytes).problems).toEqual(["code directory: the hash of special slot 2 does not match"])
  })

  test("refuses bytes after the signature, which nothing covers", () => {
    const bytes = machO({ trailing: 16 })
    expect(checkAdhocSignature(bytes).problems[0]).toMatch(/does not end the file/)
  })

  test("refuses a signature with SHA-1 only", () => {
    expect(checkAdhocSignature(machO({ sha1: true })).problems).toEqual(["no code directory uses SHA-256"])
  })

  test("refuses a file that is not a thin 64-bit Mach-O, or has no signature", () => {
    expect(checkAdhocSignature(new Uint8Array(64)).problems).toEqual(["not a thin 64-bit Mach-O file"])
    const unsigned = machO()
    new DataView(unsigned.buffer).setUint32(32 + 72, 0x1e, true) // no longer LC_CODE_SIGNATURE
    expect(checkAdhocSignature(unsigned).problems).toEqual(["no code signature"])
  })
})

describe("signMacOSBinary", () => {
  const options = { identifier: "rafikicode", platform: "linux", rcodesign: null }

  test("a release build without a signer stops", async () => {
    await expect(signMacOSBinary("dist/rafikicode-darwin-arm64/bin/rafikicode", { ...options, required: true })).rejects.toThrow(
      "rcodesign is not on PATH (RAFIKICODE_REQUIRE_MACOS_SIGNATURE=1)",
    )
  })

  test("a local build without a signer leaves the file as it is", async () => {
    expect(await signMacOSBinary("dist/rafikicode-darwin-arm64/bin/rafikicode", { ...options, required: false })).toBeUndefined()
  })
})
