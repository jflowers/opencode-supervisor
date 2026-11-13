/**
 * Plugin Identity
 * Leaf module holding the plugin's one name (review finding #9): the
 * registered `plugin.id`, the session-config key under
 * `session.config.plugins`, and the server-log service tag all read
 * this constant, so the three can never drift apart. Imports nothing.
 */

/** The plugin id, session-config key, and log service tag. */
export const PLUGIN_ID = 'opencode-supervisor';
