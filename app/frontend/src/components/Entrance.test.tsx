import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Persona } from "../api";
import Entrance from "./Entrance";

const personas = [
  {
    id: "cfo",
    label: "CFO",
    title: "Chief Financial Officer",
    description: "Consolidated KPIs across every geography.",
    default_page: "executive",
    pages: ["executive"],
    scope_type: "consolidated",
    scope_locked: true,
    can_post: false,
  },
  {
    id: "controller",
    label: "Controller",
    title: "Regional Controller",
    description: "Close readiness and variance analysis.",
    default_page: "dashboard",
    pages: ["dashboard"],
    scope_type: "region",
    scope_locked: false,
    can_post: true,
  },
  {
    id: "accountant",
    label: "Accountant",
    title: "Accountant",
    description: "Transactional workbench.",
    default_page: "tasks",
    pages: ["tasks"],
    scope_type: "legal_entity",
    scope_locked: false,
    can_post: true,
  },
] satisfies Persona[];

describe("Entrance", () => {
  it("renders the login card, SSO, and a button for every persona", () => {
    const html = renderToStaticMarkup(
      <Entrance personas={personas} savedId="cfo" onEnter={() => {}} />,
    );

    expect(html).toContain('data-testid="entrance-wordmark"');
    expect(html).toContain("Office");
    expect(html).toContain("of the");
    expect(html).toContain("CFO");
    expect(html).not.toContain("h-2 w-2 rounded-full");
    expect(html).toContain("Welcome back");
    expect(html).toContain("Sign in to access your financial operating system.");
    expect(html).not.toContain("Secure access for authorized finance teams.");
    expect(html).toContain("Forgot password?");
    expect(html).toContain("Continue with Microsoft");
    expect(html).toContain("Sign in");
    expect(html).toContain("CFO");
    expect(html).toContain("Controller");
    expect(html).toContain("Accountant");
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-testid="entrance-signal-network"');
    expect(html).not.toContain("entrance-grid");
  });

  it("shows a loading state before personas arrive", () => {
    const html = renderToStaticMarkup(
      <Entrance personas={[]} savedId={null} onEnter={() => {}} />,
    );

    expect(html).toContain("Loading roles");
    expect(html).toContain('role="status"');
  });

  it("offers a retry when roles cannot be loaded", () => {
    const html = renderToStaticMarkup(
      <Entrance
        personas={[]}
        savedId={null}
        loadError="Roles are temporarily unavailable."
        onEnter={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain("Unable to load roles");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Loading roles");
  });
});
