import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ViewTabs } from "./ViewTabs";

const mockUseLocation = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: any) => <a href={to} to={to} {...props}>{children}</a>,
  useLocation: (...args: any[]) => mockUseLocation(...args),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: any) => <>{children}</>,
}));

describe("ViewTabs", () => {
  it("renders a Global link to the full-page global settings route", () => {
    mockUseLocation.mockReturnValue({
      pathname: "/projects/demo/configure",
    });

    render(<ViewTabs />);

    const globalLink = screen.getByRole("link", { name: "Global" });
    expect(globalLink.getAttribute("to")).toBe("/global-configure");
  });
});
