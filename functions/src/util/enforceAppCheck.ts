// Skip App Check enforcement when running under the Firebase emulator.
// FUNCTIONS_EMULATOR is set by the emulator runtime and is never set in
// production, so this is `true` in production (matches CLAUDE.md rule #9)
// and `false` in local dev where App Check would otherwise reach out to the
// real Firebase App Check service and block every call.
export const ENFORCE_APP_CHECK = process.env.FUNCTIONS_EMULATOR !== 'true'
