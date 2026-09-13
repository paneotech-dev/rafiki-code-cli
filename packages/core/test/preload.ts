import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
// The config plugin tests load plugins from temporary directories: trust them,
// so they keep testing upstream loading (workspace trust is tested in packages/opencode/test/rafiki).
process.env.RAFIKICODE_TRUST_WORKSPACE = "1"
