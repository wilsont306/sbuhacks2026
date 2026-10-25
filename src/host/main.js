// Host page entry. Order matters: scene.js defines window.game synchronously; glue.js then wires the
// hub socket, the margins and the operator keys onto it; apibox.js (K) then adds the API plug-in box and its button.
import './scene.js';
import './glue.js';
import './apibox.js';
import './cover.js'; // last: the "Canvas Express" cover over everything, until its ticket opens the gallery
import { trackVisible } from './fit.js';

trackVisible(); // host.css fits the frame to the part of the window that is on screen
