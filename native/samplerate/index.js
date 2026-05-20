// Lazy-loaded entry point. Errors here (missing .node, ABI mismatch with
// Stream Deck's bundled Node) propagate as a thrown require() — callers
// catch and degrade gracefully.
module.exports = require('./build/Release/asrc.node');
