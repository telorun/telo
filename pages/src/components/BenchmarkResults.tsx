import { useEffect, useState } from "react";
import {
  HISTORY_BASE,
  commonSize,
  featureTrend,
  latestFeatures,
  linePath,
  parseJsonl,
  ratioTrend,
  summarize,
  type ComparisonRow,
  type FeatureRow,
  type TrendPoint,
} from "./benchmark-data";

type Loaded =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "error"; message: string }
  | { state: "ready"; comparison: ComparisonRow[]; features: FeatureRow[] };

async function fetchHistory<T>(name: string): Promise<T[] | null> {
  let response: Response;
  try {
    response = await fetch(`${HISTORY_BASE}/${name}`);
  } catch {
    return null;
  }
  return response.ok ? parseJsonl<T>(name, await response.text()) : null;
}

const fixed = (value: number | null, digits: number) => (value === null ? "–" : value.toFixed(digits));

function Chart({ title, points, unit }: { title: string; points: TrendPoint[]; unit: string }) {
  const width = 360;
  const height = 120;
  const { path, min, max } = linePath(points, width, height);
  return (
    <figure className="benchmarkChart">
      <figcaption>{title}</figcaption>
      {points.length === 0 ? (
        <p>No data.</p>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
          <path d={path} className="benchmarkChartLine" />
          {points.length === 1 && <circle cx={width / 2} cy={height / 2} r={3} className="benchmarkChartDot" />}
        </svg>
      )}
      {points.length > 0 && (
        <p className="benchmarkChartRange">
          {points.length} runs, {fixed(min, 3)} to {fixed(max, 3)} {unit}
        </p>
      )}
    </figure>
  );
}

function Results({ comparison, features }: { comparison: ComparisonRow[]; features: FeatureRow[] }) {
  const latest = comparison[comparison.length - 1];
  const summary = latest ? summarize(latest) : [];
  const latestFeature = latestFeatures(features);
  return (
    <div className="benchmarkResults">
      {latest && (
        <>
          <h3>Telo against Node</h3>
          <p>
            Latest run{latest.commit ? ` at ${latest.commit.slice(0, 7)}` : ""}
            {latest.teloVersion ? `, telo ${latest.teloVersion}` : ""}
            {latest.host?.model ? `, ${latest.host.model} (${latest.host.cpus} CPUs)` : ""}. Ratios are <code>telo</code> ÷{" "}
            <code>node</code> of the medians, so lower is better for Telo.
          </p>
          <table>
            <thead>
              <tr>
                <th>Workload</th>
                <th>CPU per request ratio</th>
                <th>p99 ratio</th>
                <th>Throughput ratio</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((w) => (
                <tr key={w.workload}>
                  <td>{w.workload}</td>
                  <td>{fixed(w.cpuRatio, 2)}</td>
                  <td>{fixed(w.p99Ratio, 2)}</td>
                  <td>{fixed(w.throughputRatio, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Workload</th>
                <th>Subject</th>
                <th>Throughput (req/s)</th>
                <th>p50 (ms)</th>
                <th>p99 (ms)</th>
                <th>CPU per request (ms)</th>
                <th>Peak RSS (MiB)</th>
              </tr>
            </thead>
            <tbody>
              {summary.flatMap((w) =>
                w.subjects.map((s) => (
                  <tr key={`${w.workload}/${s.subject}`}>
                    <td>{w.workload}</td>
                    <td>{s.subject}</td>
                    <td>
                      {fixed(s.throughput, 0)}
                      {s.generatorBound ? " (generator-bound)" : ""}
                    </td>
                    <td>{fixed(s.p50Ms, 2)}</td>
                    <td>{fixed(s.p99Ms, 2)}</td>
                    <td>{fixed(s.cpuPerRequestMs, 4)}</td>
                    <td>{s.peakRssBytes === null ? "–" : fixed(s.peakRssBytes / 1048576, 1)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Cold boot (ms)</th>
                <th>Warm boot (ms)</th>
                <th>Startup span (ms)</th>
              </tr>
            </thead>
            <tbody>
              {latest.bootResults.map((b) => (
                <tr key={b.subject}>
                  <td>{b.subject}</td>
                  <td>{fixed(b.coldMs.median, 0)}</td>
                  <td>{fixed(b.warmMs.median, 0)}</td>
                  <td>{fixed(b.startupMs?.median ?? null, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Trends</h3>
          <div className="benchmarkCharts">
            {summary.flatMap((w) => [
              <Chart key={`${w.workload}/cpu`} title={`${w.workload}: CPU per request ratio`} points={ratioTrend(comparison, w.workload, "cpuRatio")} unit="×" />,
              <Chart key={`${w.workload}/p99`} title={`${w.workload}: p99 ratio`} points={ratioTrend(comparison, w.workload, "p99Ratio")} unit="×" />,
            ])}
          </div>
        </>
      )}
      {latestFeature.length > 0 && (
        <>
          <h3>Feature cost</h3>
          <p>
            Warm <code>telo run</code> and <code>telo check</code> medians at the largest size the latest run completed, and the first size at
            which the feature failed to boot.
          </p>
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Largest N</th>
                <th>Run (ms)</th>
                <th>Check (ms)</th>
                <th>First failure</th>
              </tr>
            </thead>
            <tbody>
              {latestFeature.map((f) => {
                const n = commonSize([f]);
                const at = f.sizes.find((s) => s.n === n);
                return (
                  <tr key={f.feature}>
                    <td>{f.feature}</td>
                    <td>{n ?? "–"}</td>
                    <td>{fixed(at?.runWarmMs.median ?? null, 0)}</td>
                    <td>{fixed(at?.checkWarmMs.median ?? null, 0)}</td>
                    <td>{f.firstFailure ? `N = ${f.firstFailure.n}` : "none"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="benchmarkCharts">
            {latestFeature.map((f) => {
              const trend = featureTrend(features, f.feature, "runWarmMs");
              return (
                <Chart
                  key={f.feature}
                  title={`${f.feature}: warm run time${trend.n === null ? "" : ` at N = ${trend.n}`}`}
                  points={trend.points}
                  unit="ms"
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function BenchmarkResults() {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    let current = true;
    Promise.all([fetchHistory<ComparisonRow>("comparison.jsonl"), fetchHistory<FeatureRow>("feature-cost.jsonl")]).then(
      ([comparison, features]) => {
        if (!current) return;
        if (!comparison?.length && !features?.length) setLoaded({ state: "empty" });
        else setLoaded({ state: "ready", comparison: comparison ?? [], features: features ?? [] });
      },
      (error: Error) => current && setLoaded({ state: "error", message: error.message }),
    );
    return () => {
      current = false;
    };
  }, []);

  if (loaded.state === "loading") return <p>Loading results…</p>;
  if (loaded.state === "empty") return <p>No results yet.</p>;
  if (loaded.state === "error") return <p>The results could not be read: {loaded.message}</p>;
  return <Results comparison={loaded.comparison} features={loaded.features} />;
}
