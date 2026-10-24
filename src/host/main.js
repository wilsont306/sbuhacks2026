// Host page entry. Order matters: scene.js defines window.game synchronously; glue.js then wires the
// hub socket, the margins and the operator keys onto it.
import './scene.js';
import './glue.js';
