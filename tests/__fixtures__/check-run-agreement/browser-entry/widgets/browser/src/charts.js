import { h } from "@fixture/host";
import { label } from "./shared.js";

export function Bar(props) {
  return h("div", { title: label(props.done) });
}
