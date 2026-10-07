import "./badges.css";
import { h } from "@fixture/host";
import { label } from "./shared.js";

export function StatusPill(props) {
  return h("span", { class: "status-pill" }, label(props.done));
}
