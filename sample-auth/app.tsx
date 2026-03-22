import React from "react";
import { createRoot } from "react-dom/client";
import { SessionProvider, useSession } from "../src/client/index.ts";
import "./styles.css";
import { LoginPage } from "./pages/login.tsx";
import { DashboardPage } from "./pages/dashboard.tsx";

function Router() {
  const { status } = useSession();
  const path = window.location.pathname;

  if (status === "loading") {
    return (
      <div className="loading">
        <div className="spinner" />
        Loading...
      </div>
    );
  }

  if (path === "/login") {
    if (status === "authenticated") {
      window.location.href = "/dashboard";
      return null;
    }
    return <LoginPage />;
  }

  if (path === "/dashboard" || path === "/") {
    if (status === "unauthenticated") {
      window.location.href = "/login";
      return null;
    }
    return <DashboardPage />;
  }

  return (
    <div className="container">
      <div className="card">
        <h1>404</h1>
        <p>Page not found.</p>
        <a href="/" className="btn">Go Home</a>
      </div>
    </div>
  );
}

function App() {
  return (
    <SessionProvider basePath="/api/auth">
      <Router />
    </SessionProvider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
