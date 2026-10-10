// Output written to a pipe is not written at once: what the reader has not
// taken yet waits in the process, and process.exit drops it. A command that
// printed more than the pipe holds (64 KiB on Linux) and then exited lost the
// rest, so `rafikicode export <id> | tool` cut long sessions at a 64 KiB
// boundary. Every exit goes through flush first: it waits until stdout and
// stderr have handed everything to the reader, or until the reader is gone
// (closed pipe, write error).
//
// Under Bun neither the callback of a write nor writableLength says when a
// pipe has taken the data; a write that returned false followed by the
// "drain" event does. install() records which streams are waiting for one.
type Stream = NodeJS.WriteStream

const waiting = new WeakMap<Stream, Promise<void>>()
const installed = new WeakSet<Stream>()

function watch(stream: Stream) {
  if (installed.has(stream)) return
  installed.add(stream)
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean
  stream.write = ((...args: unknown[]) => {
    const ok = write(...args)
    if (!ok && !waiting.has(stream)) {
      waiting.set(
        stream,
        new Promise<void>((resolve) => {
          const done = () => {
            stream.off("drain", done)
            stream.off("error", done)
            stream.off("close", done)
            waiting.delete(stream)
            resolve()
          }
          stream.on("drain", done)
          stream.on("error", done)
          stream.on("close", done)
        }),
      )
    }
    return ok
  }) as Stream["write"]
}

// Called once at startup, before anything is printed.
export function install(streams: Stream[] = [process.stdout, process.stderr]) {
  for (const stream of streams) watch(stream)
}

// Resolves once every watched stream has handed its output to the reader.
export async function flush(streams: Stream[] = [process.stdout, process.stderr]) {
  for (;;) {
    const pending = streams.map((stream) => waiting.get(stream)).filter((p): p is Promise<void> => p !== undefined)
    if (pending.length === 0) return
    await Promise.all(pending)
  }
}

// process.exit, once the output is out.
export async function exit(code?: number): Promise<never> {
  await flush()
  return process.exit(code)
}
