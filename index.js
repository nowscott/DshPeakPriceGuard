/**
 * Host half of the peak-price guard bundle.
 *
 * The guard is a browser behaviour: it wraps the Conversation composer's send
 * sink, so the reminder and the confirmation live in the Client module
 * (`./client.js`). This Host entry stays inert; it exists so the bundle has an
 * inventory row the user can enable, disable, and uninstall.
 */
export function apply() {}
