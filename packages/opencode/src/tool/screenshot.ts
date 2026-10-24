import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import { generateText } from "ai"
import { Brand } from "@opencode-ai/core/brand/brand"
import * as Tool from "./tool"
import DESCRIPTION from "./screenshot.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Browser from "@/rafiki/browser"
import * as DevServer from "@/rafiki/dev-server"
import * as RafikiRouting from "@/rafiki/routing"
import { Provider } from "@/provider/provider"

export const Parameters = Schema.Struct({
  url: Schema.optional(Schema.String).annotate({
    description:
      "What to open: an http(s) URL, a file:// URL or the path of an HTML file. With dev_server, a path on the dev server such as /pricing (default /)",
  }),
  dev_server: Schema.optional(Schema.Boolean).annotate({
    description:
      "Start the project's dev server (the dev, start, serve or preview script of package.json) in the background, or reuse the one already started, and open it",
  }),
  viewports: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: 'Viewports: "desktop" (1440x900), "mobile" (390x844) or "WIDTHxHEIGHT". Default: desktop and mobile',
  }),
  full_page: Schema.optional(Schema.Boolean).annotate({
    description: "Capture the whole page height instead of the first screen",
  }),
  look_for: Schema.optional(Schema.String).annotate({
    description:
      "What the page should show, in a sentence, for the tier that looks at the screenshots when this one takes no images",
  }),
})

// What the image model is asked when the session's model takes no images.
export function lookPrompt(url: string, names: string[], lookFor?: string) {
  return [
    `These are screenshots of ${url} at ${names.join(" and ")} width. Another model is building this page and cannot see images: describe it for that model, in under 250 words.`,
    lookFor ? `The page should show: ${lookFor}` : "",
    "Cover: the layout from top to bottom (sections, columns, alignment), the visual hierarchy, spacing that looks off, text that is cut, overlapping or hard to read, images that are broken or missing, and what differs between the widths. End with the three changes that would improve it most. No praise.",
  ]
    .filter(Boolean)
    .join("\n")
}

type ModelInfo = { providerID?: string; id?: string; capabilities?: { input?: { image?: boolean } } }

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"])

// Whether a URL stays on this machine: a file, or a server on the loopback.
export function isLocal(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === "file:") return true
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && (LOCAL_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".localhost"))
  } catch {
    return false
  }
}

// An http(s) or file URL, or a path made into a file URL.
export function target(value: string, directory: string) {
  if (/^https?:\/\//i.test(value) || /^file:\/\//i.test(value)) return value
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return undefined
  return pathToFileURL(path.resolve(directory, value)).href
}

export const ScreenshotTool = Tool.define<typeof Parameters, Record<string, unknown>, Provider.Service>(
  "screenshot",
  Effect.gen(function* () {
    const provider = yield* Provider.Service

    // On a Rafiki tier that takes no images, the routing helper names the tier
    // that looks at the pictures (rafiki/routing.ts, lookTier) and its answer
    // comes back as text. Undefined when there is no such tier: the measures
    // still go to the model.
    const look = (input: { shots: Browser.Shot[]; url: string; lookFor?: string; current?: ModelInfo; ctx: Tool.Context }) =>
      Effect.gen(function* () {
        const route = RafikiRouting.lookTier({ providerID: input.current?.providerID, tier: input.current?.id ?? "" })
        if (!route) return undefined
        const ref = `${input.current!.providerID}/${route.tier}`
        const parsed = Provider.parseModel(ref)
        const model = yield* provider.getModel(parsed.providerID, parsed.modelID).pipe(Effect.option)
        if (model._tag === "None") return { model: route.tier, text: undefined, note: `${route.tier} is not available` }
        if (!model.value.capabilities.input.image) return { model: route.tier, text: undefined, note: `${route.tier} takes no images` }
        yield* Effect.logInfo("routing", { purpose: "look", tier: route.tier, reason: route.reason })
        const language = yield* provider.getLanguage(model.value)
        const pictures = input.shots.filter((shot) => shot.image)
        const result = yield* Effect.tryPromise({
          try: () =>
            generateText({
              model: language,
              maxOutputTokens: 1_500,
              maxRetries: 1,
              abortSignal: AbortSignal.any([input.ctx.abort, AbortSignal.timeout(120_000)]),
              headers: { "User-Agent": Brand.userAgent(), "X-Session-Id": input.ctx.sessionID },
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: lookPrompt(input.url, pictures.map((shot) => shot.viewport.name), input.lookFor) },
                    ...pictures.map((shot) => ({ type: "image" as const, image: shot.image!.data, mediaType: shot.image!.mime })),
                  ],
                },
              ],
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.option)
        if (result._tag === "None") return { model: route.tier, text: undefined, note: `${route.tier} could not be reached` }
        const text = result.value.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
        return { model: route.tier, text: text || undefined, note: text ? undefined : `${route.tier} gave no answer` }
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const views = (params.viewports?.length ? params.viewports : ["desktop", "mobile"]).map((item) => ({
            item,
            view: Browser.viewport(item),
          }))
          const wrong = views.filter((entry) => !entry.view).map((entry) => entry.item)
          if (wrong.length)
            return yield* Effect.fail(
              new Error(`Unknown viewport ${wrong.join(", ")}: use desktop, mobile or WIDTHxHEIGHT such as 1280x720.`),
            )
          const viewports = views.flatMap((entry) => (entry.view ? [entry.view] : []))

          const browser = Browser.find()
          if (!browser) return { title: "No browser", output: Browser.missingMessage(), metadata: { browser: false } }

          let url: string | undefined
          if (params.dev_server) {
            const plan = DevServer.plan(instance.directory)
            if (!plan)
              return yield* Effect.fail(
                new Error(
                  `No dev server to start: package.json in ${instance.directory} has none of the scripts ${DevServer.SCRIPTS.join(", ")}. Open the HTML file instead, or start the server with the shell tool and pass its URL.`,
                ),
              )
            if (!DevServer.runningIn(plan.dir))
              yield* ctx.ask({
                permission: "bash",
                patterns: [plan.display],
                always: [plan.display],
                metadata: { command: plan.display, workdir: plan.dir, description: "Start the dev server for screenshots" },
              })
            const base = yield* Effect.tryPromise({
              try: () => DevServer.start(plan),
              catch: (error) => (error instanceof Error ? error : new Error(String(error))),
            })
            url = params.url && !/^[a-z]+:\/\//i.test(params.url) ? new URL(params.url, base).href : (params.url ?? base)
          } else {
            if (!params.url)
              return yield* Effect.fail(new Error("Give a url (an http(s) URL or an HTML file), or set dev_server."))
            url = target(params.url, instance.directory)
            if (!url) return yield* Effect.fail(new Error(`Only http, https and file URLs can be opened, not ${params.url}.`))
          }

          if (url.startsWith("file:")) {
            yield* assertExternalDirectoryEffect(ctx, fileURLToPath(url), { kind: "file" })
          } else if (!isLocal(url)) {
            // A page on the internet is fetched by the browser: the same question as webfetch.
            yield* ctx.ask({ permission: "webfetch", patterns: [url], always: ["*"], metadata: { url } })
          }

          const model = ctx.extra?.model as ModelInfo | undefined
          const images = model?.capabilities?.input?.image === true
          const shots = yield* Effect.tryPromise({
            try: () =>
              Browser.capture({ browser, url: url!, viewports, fullPage: params.full_page === true, image: true }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          })
          const pictures = shots.filter((shot) => shot.image)
          // A model that takes no images gets the measures, and the description
          // of the tier the routing helper sends the pictures to, when there is one.
          const seen = !images && pictures.length ? yield* look({ shots, url, lookFor: params.look_for, current: model, ctx }) : undefined
          const text = [
            `Screenshot of ${url}`,
            ...shots.map(Browser.describe),
            images
              ? pictures.length
                ? `Attached: ${pictures.map((shot) => shot.viewport.name).join(" and ")} screenshot${pictures.length > 1 ? "s" : ""}.`
                : ""
              : seen?.text
                ? `What ${seen.model} sees in the screenshots:\n${seen.text}`
                : `This model takes no images: the measures above describe the page. Fix overflow, overlaps, contrast, console errors and missing labels from them.${seen?.note ? ` (No description: ${seen.note}.)` : ""}`,
          ].filter(Boolean)
          return {
            title: url,
            output: text.join("\n"),
            metadata: {
              browser: true,
              url,
              viewports: viewports.map((view) => view.name),
              images: images ? pictures.length : 0,
              ...(seen?.text ? { lookModel: seen.model } : {}),
            },
            ...(images && pictures.length
              ? {
                  attachments: pictures.map((shot) => ({
                    type: "file" as const,
                    mime: shot.image!.mime,
                    filename: `screenshot-${shot.viewport.name}.${shot.image!.mime === "image/png" ? "png" : "jpg"}`,
                    url: `data:${shot.image!.mime};base64,${shot.image!.data}`,
                  })),
                }
              : {}),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
