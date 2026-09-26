/**
 * The build id compiled into every browser chunk by the vite buildIdPlugin:
 * the entry chunk's content hash, so it changes with every deployment.
 * null on the dev server (no build) and for any code that runs in the service
 * worker (the plugin only runs for the client environment).
 */
declare const __AOS_BUILD_ID__: string | null | undefined
