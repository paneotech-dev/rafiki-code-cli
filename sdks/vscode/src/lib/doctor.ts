// A one line summary of `rafikicode doctor` for a notification; the full
// report goes to the output channel.
import { stripAnsi } from "./keystate"

export interface DoctorSummary {
  ok: boolean
  failed: number
  warned: number
  message: string
}

export function summarizeDoctor(output: string, exitCode: number | null): DoctorSummary {
  const all = stripAnsi(output).split(/\r?\n/)
  const failed = all.filter((line) => line.startsWith("FAIL ")).length
  const warned = all.filter((line) => line.startsWith("WARN ")).length
  if (exitCode === 0) {
    const tail = warned === 0 ? "" : warned === 1 ? ", 1 warning" : `, ${warned} warnings`
    return { ok: true, failed, warned, message: `Rafiki Code doctor: all checks passed${tail}.` }
  }
  const count = failed === 0 ? "a check failed" : failed === 1 ? "1 check needs attention" : `${failed} checks need attention`
  return { ok: false, failed, warned, message: `Rafiki Code doctor: ${count} (exit ${exitCode ?? "unknown"}).` }
}
