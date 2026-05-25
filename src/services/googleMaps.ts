import { setOptions, importLibrary } from '@googlemaps/js-api-loader'

// AK-163 — Singleton wrapper around the Google Maps JS SDK loader.
//
// The v2 loader exposes a functional API (`setOptions` once, then
// `importLibrary` per library) rather than the v1 `Loader.load()` blob.
// We import the libraries our Addresses screen actually uses (maps for the
// map renderer, places for autocomplete, marker for the draggable pin,
// geocoding for reverse-geocode on drag) and resolve when all four are
// attached to the global google.maps namespace — callers then use
// `new google.maps.Map(...)` etc. against the typed namespace from
// @types/google.maps.
//
// VITE_GOOGLE_MAPS_API_KEY is the ONLY place the key is referenced from
// app code; setOptions is what propagates it into the SDK.

let loadPromise: Promise<void> | null = null
let optionsSet = false

export function loadMapsLibrary(): Promise<void> {
  if (loadPromise) return loadPromise

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
  if (!apiKey) {
    return Promise.reject(
      new Error('VITE_GOOGLE_MAPS_API_KEY is not configured.'),
    )
  }

  if (!optionsSet) {
    setOptions({ key: apiKey, v: 'weekly' })
    optionsSet = true
  }

  // Bind to a local const before assigning to the module-scoped slot, so
  // TypeScript's flow analysis can see the variable is non-null at the
  // return site even though the catch handler reassigns it on failure.
  const p = Promise.all([
    importLibrary('maps'),
    importLibrary('places'),
    importLibrary('marker'),
    importLibrary('geocoding'),
  ])
    .then(() => undefined)
    .catch((err: unknown) => {
      // Reset the cache on failure so the next caller retries from scratch
      // (a transient network failure shouldn't poison the singleton).
      loadPromise = null
      throw err
    })

  loadPromise = p
  return p
}
