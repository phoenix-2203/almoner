// Minimal stand-in for Node's "util" in the browser bundle. Only a JSON-schema
// helper inside near-api-js asks for it, and the pages never reach that code path.
module.exports = {
  format: function () { return Array.prototype.slice.call(arguments).join(" "); },
  inspect: function (v) { try { return JSON.stringify(v); } catch (e) { return String(v); } },
};
