const api = "/api/todos";
const list = document.getElementById("list");
const empty = document.getElementById("empty");
const form = document.getElementById("new-todo");
const text = document.getElementById("text");

async function json(res) {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

function render(todos) {
  list.replaceChildren();
  empty.hidden = todos.length > 0;
  for (const todo of todos) {
    const li = document.createElement("li");
    li.className = todo.done ? "done" : "";

    const label = document.createElement("span");
    label.className = "text";
    label.textContent = todo.text;
    label.addEventListener("click", () => toggle(todo));

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", () => remove(todo.id));

    li.append(label, del);
    list.append(li);
  }
}

async function load() {
  render(await json(await fetch(api)));
}

async function add(value) {
  await json(await fetch(api, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: value }),
  }));
  await load();
}

async function toggle(todo) {
  await json(await fetch(`${api}/${todo.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ done: todo.done ? 0 : 1 }),
  }));
  await load();
}

async function remove(id) {
  await json(await fetch(`${api}/${id}`, { method: "DELETE" }));
  await load();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = text.value.trim();
  if (!value) return;
  text.value = "";
  await add(value);
});

load();
