// First import, and it must stay first: it installs the crash handlers that
// report a failure during module evaluation (rafiki/startup-guard.ts).
import "./rafiki/startup-guard"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { GhCommand } from "./cli/cmd/gh"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Startup from "./rafiki/startup"
import { DoctorCommand, LicensesCommand, LoginCommand, LogoutCommand, ProvidersCommand, TrustCommand, UsageCommand, WhoamiCommand, markHeadless, refuseMissingKey, refuseUnsafeCredential } from "./rafiki/cmd"
import * as ExecTmp from "./rafiki/exec-tmp"
import * as Autoupdate from "./rafiki/autoupdate"

// An update downloaded and verified by an earlier session is put in place here,
// before anything is parsed, and the new binary takes over with the same
// arguments. One existsSync when nothing is staged (rafiki/autoupdate.ts).
Autoupdate.applyStaged()

// The terminal interface unpacks a native library into the temporary directory
// and loads it from there, so a temporary directory mounted noexec stops this
// binary before any command runs. The directory comes from TMPDIR, which is
// read while the process starts and cannot be changed from here, so when it
// cannot run a file this starts the binary again with TMPDIR pointing at one
// that can. No-op everywhere else (rafiki/exec-tmp.ts).
ExecTmp.ensure()

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith(`${Brand.name} `)) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName(Brand.name)
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
    refuseUnsafeCredential(opts._[0])
    markHeadless(opts._[0])
    refuseMissingKey(opts)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(LoginCommand)
  .command(LogoutCommand)
  .command(WhoamiCommand)
  .command(UsageCommand)
  .command(DoctorCommand)
  .command(LicensesCommand)
  .command(TrustCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(PrCommand)
  .command(GhCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
      // Help alone never said what was wrong with the command that was typed:
      // a mistyped flag, a missing argument or a bad --method printed forty
      // lines of options and no reason, which reads as the CLI refusing for
      // no stated cause. yargs' own message names the argument, what was
      // given and, for a choices violation, what was allowed. It is written
      // after the help rather than before it so that it is the last thing on
      // screen instead of being scrolled away by the help itself.
      if (msg) process.stderr.write(EOL + msg + EOL)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  // Startup diagnosis self test: the only way to drive a startup failure of a
  // given shape through the real binary, which is how the tests assert on what
  // reaches the terminal. Does nothing unless the variable is set.
  const injected = process.env["RAFIKICODE_TEST_STARTUP_ERROR"]
  if (injected) throw new Error(injected)
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    // No "Unexpected error" banner: a failure nobody anticipated is exactly
    // the one a user needs a diagnosis, a next step and a way out for. The
    // original error text is part of every report (rafiki/startup.ts).
    Startup.report(Startup.diagnose(e), e, { argv: args })
  }
  if (process.exitCode === undefined) process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
