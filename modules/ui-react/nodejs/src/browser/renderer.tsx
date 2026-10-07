import "./base.css";
import { mount } from "./app.js";

// The renderer: loaded by the shell, it draws the application into the
// shell's root element.
export { mount };

const root = document.getElementById("telo-root");
if (root) mount(root);
