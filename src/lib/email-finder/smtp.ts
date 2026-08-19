import net from "node:net";
import type { MxLookupResult } from "./dns";

export interface SmtpProbeResult {
  attempted: boolean;
  code: number | null;
  message: string | null;
  isCatchAll: boolean;
  mailboxExists: boolean | null;
  error: string | null;
  latencyMs: number;
}

/**
 * Lightweight SMTP RCPT probe (no DATA / no delivery).
 *
 * Many providers (Gmail, M365) greylist or accept-all at the edge —
 * we detect catch-all by probing a random invalid local part first.
 * Network may block outbound 25 in some sandboxes; fail soft.
 */
export async function smtpProbe(
  email: string,
  mx: MxLookupResult,
): Promise<SmtpProbeResult> {
  const started = Date.now();
  if (!mx.hasMx || mx.mxHosts.length === 0) {
    return {
      attempted: false,
      code: null,
      message: null,
      isCatchAll: false,
      mailboxExists: null,
      error: "No MX hosts",
      latencyMs: 0,
    };
  }

  const host = mx.mxHosts[0].exchange;
  const domain = email.split("@")[1] ?? "";
  const randomLocal = `noexist-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const fakeEmail = `${randomLocal}@${domain}`;

  try {
    const catchAllCheck = await smtpRcpt(host, fakeEmail);
    const isCatchAll =
      catchAllCheck.code !== null &&
      catchAllCheck.code >= 200 &&
      catchAllCheck.code < 300;

    if (isCatchAll) {
      return {
        attempted: true,
        code: catchAllCheck.code,
        message: "Catch-all domain detected",
        isCatchAll: true,
        mailboxExists: null,
        error: null,
        latencyMs: Date.now() - started,
      };
    }

    const real = await smtpRcpt(host, email);
    const exists =
      real.code !== null && real.code >= 200 && real.code < 300
        ? true
        : real.code !== null && real.code >= 500
          ? false
          : null;

    return {
      attempted: true,
      code: real.code,
      message: real.message,
      isCatchAll: false,
      mailboxExists: exists,
      error: real.error,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      attempted: true,
      code: null,
      message: null,
      isCatchAll: false,
      mailboxExists: null,
      error: err instanceof Error ? err.message : "SMTP probe failed",
      latencyMs: Date.now() - started,
    };
  }
}

function smtpRcpt(
  host: string,
  email: string,
  timeoutMs = 5000,
): Promise<{ code: number | null; message: string | null; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let stage: "banner" | "ehlo" | "mail" | "rcpt" | "quit" = "banner";
    let lastCode: number | null = null;
    let lastMessage: string | null = null;

    const finish = (result: {
      code: number | null;
      message: string | null;
      error: string | null;
    }) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const socket = net.createConnection({ host, port: 25 });
    socket.setTimeout(timeoutMs);

    const send = (line: string) => {
      socket.write(`${line}\r\n`);
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (!Number.isNaN(code)) {
          lastCode = code;
          lastMessage = line.slice(4) || line;
        }
        // Multi-line replies end when "XYZ " (space) not "XYZ-"
        if (line.length >= 4 && line[3] === "-") continue;

        if (stage === "banner") {
          if (lastCode === 220) {
            stage = "ehlo";
            send("EHLO mailgraph.local");
          } else {
            finish({
              code: lastCode,
              message: lastMessage,
              error: "Bad SMTP banner",
            });
          }
        } else if (stage === "ehlo") {
          stage = "mail";
          send("MAIL FROM:<>");
        } else if (stage === "mail") {
          stage = "rcpt";
          send(`RCPT TO:<${email}>`);
        } else if (stage === "rcpt") {
          stage = "quit";
          send("QUIT");
          finish({
            code: lastCode,
            message: lastMessage,
            error: null,
          });
        }
      }
    });

    socket.on("timeout", () => {
      finish({ code: lastCode, message: lastMessage, error: "SMTP timeout" });
    });
    socket.on("error", (err) => {
      finish({
        code: lastCode,
        message: lastMessage,
        error: err.message,
      });
    });
    socket.on("close", () => {
      if (!settled) {
        finish({
          code: lastCode,
          message: lastMessage,
          error: lastCode ? null : "Connection closed",
        });
      }
    });
  });
}
