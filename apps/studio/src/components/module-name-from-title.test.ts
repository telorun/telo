import { describe, expect, it } from "vitest";
import { moduleIdentityFromTitle, moduleNameFromTitle } from "./module-name-from-title";

describe("moduleIdentityFromTitle", () => {
  it("uses a valid name as is, with no title", () => {
    expect(moduleIdentityFromTitle(" WeatherApi ", "application")).toEqual({ name: "WeatherApi" });
  });

  it("derives the name and keeps the typed text as the title", () => {
    expect(moduleIdentityFromTitle("new app", "application")).toEqual({ name: "NewApp", title: "new app" });
    expect(moduleIdentityFromTitle("weatherApi", "library")).toEqual({
      name: "WeatherApi",
      title: "weatherApi",
    });
  });

  it("gives nothing when no name can be derived", () => {
    expect(moduleIdentityFromTitle("", "application")).toBeUndefined();
    expect(moduleIdentityFromTitle("123 --", "application")).toBeUndefined();
  });
});

describe("moduleNameFromTitle", () => {
  it.each([
    ["hello world", "HelloWorld"],
    ["new app", "NewApp"],
    ["my-api v2", "MyApiV2"],
    ["my API", "MyAPI"],
    ["helloWorld", "HelloWorld"],
    ["  weather_api ", "WeatherApi"],
    ["2 fast cars", "FastCars"],
    ["HelloWorld", "HelloWorld"],
  ])("%s -> %s", (title, expected) => {
    expect(moduleNameFromTitle(title)).toBe(expected);
  });

  it("derives nothing when no letter survives", () => {
    expect(moduleNameFromTitle("123 --")).toBeUndefined();
    expect(moduleNameFromTitle("  ")).toBeUndefined();
  });
});
