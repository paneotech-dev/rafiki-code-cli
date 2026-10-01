// Release platform coverage: which of the built binaries the build host can
// actually execute, and whether any two targets produced the same bytes.
//
// Why this exists. The 0.1.7 release published twelve binaries, four of them
// labelled "baseline" for x64 CPUs without AVX2. All four were byte identical
// to their non-baseline siblings: the Bun in use serves one runtime per
// os/arch/abi, so asking it for a baseline target yields the same runtime under
// a different name. Nothing caught it. The installer's own detection is right --
// it reads avx2 out of /proc/cpuinfo and asks for the baseline archive -- so the
// defect was invisible from that side, and the only smoke test ran targets
// matching the build host, which had AVX2. A duplicate therefore looked exactly
// like a pass.
//
// These functions take facts that build.ts has already gathered and decide or
// render; nothing here downloads, builds or runs anything, so the rules can be
// tested without cutting a release.

export type TargetSpec = {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  // Present and false means the baseline variant, for x64 CPUs without AVX2.
  avx2?: false
}

export type HostSpec = {
  os: string
  arch: string
  abi?: "musl"
  // Whether the build host's own CPU has AVX2. Undefined means unknown, which
  // is treated as "not proven to have it".
  avx2?: boolean
}

export type BuiltBinary = {
  name: string
  target: TargetSpec
  sha256: string
}

export type CoverageRow = {
  name: string
  sha256: string
  ran: boolean
  // Why the host could not run it, when it could not.
  skipped?: string
  // Set when the run happened but proves less than it appears to.
  caveat?: string
  // Names of other targets that produced these same bytes.
  identicalTo?: string[]
}

const abiOf = (spec: { abi?: "musl" }) => spec.abi ?? "glibc"

/**
 * Why the build host cannot execute this target's binary, or undefined when it
 * can. The host is one os/arch/libc combination, so every other target is only
 * ever cross compiled. Naming the dimension that differs keeps the release log
 * honest about which assets were never started at all.
 */
export function skipReason(target: TargetSpec, host: HostSpec): string | undefined {
  if (target.os !== host.os) return `built for ${target.os}, host is ${host.os}`
  if (target.arch !== host.arch) return `built for ${target.arch}, host is ${host.arch}`
  if (target.os === "linux" && abiOf(target) !== abiOf(host)) {
    return `built against ${abiOf(target)}, host libc is ${abiOf(host)}`
  }
  // A baseline binary runs anywhere its non-baseline sibling runs, so a host
  // with AVX2 can start it. The reverse is not true: a host without AVX2
  // cannot be used to test a build that assumes it.
  if (target.arch === "x64" && target.avx2 !== false && host.avx2 === false) {
    return "needs a CPU with AVX2, host CPU has none"
  }
  return undefined
}

/**
 * What a successful run of this target on this host still does not prove.
 *
 * Starting a baseline binary on a host that has AVX2 exercises none of the
 * reason the baseline variant exists: the same bytes would start there whether
 * or not they require instructions the target CPU lacks. Reporting the run
 * without this is how four duplicate archives passed for three releases.
 */
export function runCaveat(target: TargetSpec, host: HostSpec): string | undefined {
  if (target.avx2 === false && host.avx2 !== false) {
    return "ran on a host with AVX2, so the CPUs this variant exists for are still untested"
  }
  return undefined
}

/** Groups of two or more targets whose binaries are byte identical. */
export function duplicateGroups(binaries: BuiltBinary[]): BuiltBinary[][] {
  const bySha = new Map<string, BuiltBinary[]>()
  for (const binary of binaries) {
    const group = bySha.get(binary.sha256)
    if (group) group.push(binary)
    else bySha.set(binary.sha256, [binary])
  }
  return [...bySha.values()].filter((group) => group.length > 1)
}

/**
 * Baseline archives that are byte identical to the sibling they are supposed to
 * differ from. This is the specific duplicate that matters to a user: the
 * installer picks the baseline archive precisely when the CPU cannot run the
 * other one, so a collision here means the selection cannot help anybody.
 */
export function baselineCollisions(binaries: BuiltBinary[]): { baseline: BuiltBinary; sibling: BuiltBinary }[] {
  const out: { baseline: BuiltBinary; sibling: BuiltBinary }[] = []
  for (const baseline of binaries) {
    if (baseline.target.avx2 !== false) continue
    for (const sibling of binaries) {
      if (sibling === baseline) continue
      if (sibling.target.avx2 === false) continue
      if (sibling.target.os !== baseline.target.os) continue
      if (sibling.target.arch !== baseline.target.arch) continue
      if (abiOf(sibling.target) !== abiOf(baseline.target)) continue
      if (sibling.sha256 !== baseline.sha256) continue
      out.push({ baseline, sibling })
    }
  }
  return out
}

/** Rows for every built target, in the order they were built. */
export function coverageRows(binaries: BuiltBinary[], host: HostSpec, ran: Set<string>): CoverageRow[] {
  const groups = duplicateGroups(binaries)
  return binaries.map((binary) => {
    const skipped = skipReason(binary.target, host)
    const group = groups.find((candidate) => candidate.some((member) => member.name === binary.name))
    const identicalTo = group?.filter((member) => member.name !== binary.name).map((member) => member.name)
    return {
      name: binary.name,
      sha256: binary.sha256,
      ran: ran.has(binary.name),
      ...(skipped ? { skipped } : {}),
      ...(ran.has(binary.name) ? { caveat: runCaveat(binary.target, host) } : {}),
      ...(identicalTo?.length ? { identicalTo } : {}),
    }
  })
}

/**
 * The release's own record of what was and was not exercised, written next to
 * the archives so the answer to "has this ever been run" does not depend on
 * reading a workflow log that expires.
 */
export function renderReport(rows: CoverageRow[], host: HostSpec, version: string): string {
  const lines: string[] = []
  const hostAbi = host.os === "linux" ? `/${abiOf(host)}` : ""
  const hostAvx2 = host.avx2 === undefined ? "unknown" : host.avx2 ? "yes" : "no"
  lines.push(`# Platform coverage for ${version}`)
  lines.push("")
  lines.push(`Built on ${host.os}/${host.arch}${hostAbi}, host CPU has AVX2: ${hostAvx2}.`)
  lines.push("")
  lines.push("A binary is only ever started when the build host can run it. Everything")
  lines.push("else is cross compiled and published without being executed once.")
  lines.push("")
  lines.push("| target | sha256 | executed | note |")
  lines.push("| --- | --- | --- | --- |")
  for (const row of rows) {
    const note = [row.skipped, row.caveat, row.identicalTo?.length ? `same bytes as ${row.identicalTo.join(", ")}` : ""]
      .filter(Boolean)
      .join("; ")
    lines.push(`| ${row.name} | \`${row.sha256.slice(0, 16)}\` | ${row.ran ? "yes" : "no"} | ${note || "-"} |`)
  }
  const never = rows.filter((row) => !row.ran)
  lines.push("")
  lines.push(`${rows.length - never.length} of ${rows.length} targets were executed on the build host.`)
  if (never.length) {
    lines.push("")
    lines.push("Never executed:")
    for (const row of never) lines.push(`- ${row.name} (${row.skipped ?? "no reason recorded"})`)
  }
  return lines.join("\n") + "\n"
}

/**
 * The warning block printed when baseline archives duplicate their siblings.
 * Returns an empty string when there is nothing wrong, so the caller can treat
 * a non-empty result as the thing to show.
 */
export function duplicateWarning(binaries: BuiltBinary[]): string {
  const collisions = baselineCollisions(binaries)
  const groups = duplicateGroups(binaries)
  if (!collisions.length && !groups.length) return ""
  const lines: string[] = []
  if (collisions.length) {
    lines.push(`${collisions.length} baseline archive(s) are byte identical to the build they exist to replace:`)
    for (const { baseline, sibling } of collisions) lines.push(`  ${baseline.name} == ${sibling.name}`)
    lines.push("")
    lines.push("The installer asks for the baseline archive when the CPU has no AVX2,")
    lines.push("so these CPUs receive the same binary that cannot run for them. Either")
    lines.push("build with a toolchain that emits a real baseline runtime, or stop")
    lines.push("publishing the baseline archives and say which CPUs are unsupported.")
  }
  const other = groups.filter(
    (group) => !collisions.some(({ baseline }) => group.some((member) => member.name === baseline.name)),
  )
  if (other.length) {
    if (lines.length) lines.push("")
    lines.push("Other targets that produced identical bytes:")
    for (const group of other) lines.push(`  ${group.map((member) => member.name).join(" == ")}`)
  }
  return lines.join("\n")
}
