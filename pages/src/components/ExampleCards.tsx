import Link from "@docusaurus/Link";

const EXAMPLES: { icon: string; title: string; anchor: string; body: string }[] = [
  {
    icon: "📋",
    title: "A todo service with its admin screen",
    anchor: "todoapp",
    body: "A web API and a screen to list, filter, create, edit and delete records, served together from one description. No hand-written frontend.",
  },
  {
    icon: "📦",
    title: "Order fulfilment that survives a crash",
    anchor: "durableorders",
    body: "Reserve stock, charge a card, ship. Kill the process halfway and start it again: it continues where it stopped instead of charging twice.",
  },
  {
    icon: "✅",
    title: "An expense that waits for a manager",
    anchor: "approvalworkflow",
    body: "The work stops for as long as a person takes to approve, holds nothing while it waits, and picks up when the approval arrives.",
  },
  {
    icon: "🤖",
    title: "A support inbox an AI assistant can use",
    anchor: "supportinboxmcp",
    body: "One set of ticket actions offered both as a web API for your app and as tools an AI assistant can call, without a second service to keep in sync.",
  },
];

export default function ExampleCards() {
  return (
    <>
      <div className="row">
        {EXAMPLES.map((example) => (
          <div key={example.anchor} className="col col--6 margin-bottom--md">
            <Link className="card cardLink" to={`/examples#${example.anchor}`}>
              <div className="card__header text--center">
                <div style={{ fontSize: "2.5rem", lineHeight: 1 }} aria-hidden>
                  {example.icon}
                </div>
                <h3 className="margin-top--sm margin-bottom--none">{example.title}</h3>
              </div>
              <div className="card__body">{example.body}</div>
            </Link>
          </div>
        ))}
      </div>
      <p className="text--center">
        These are runnable examples from the repository, not customer stories.{" "}
        <Link to="/examples">See all examples →</Link>
      </p>
    </>
  );
}
