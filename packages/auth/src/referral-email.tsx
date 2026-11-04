/** @jsxRuntime automatic */
import type { TransactionalEmail } from "@orkbot/adapter-kit";
import { INVITED_TRIAL_WEEKS } from "@orkbot/contracts";
import { Link, Text } from "react-email";
import { emailText, greeting, linkStyle, message } from "./email.js";

export function referralEmail(
  user: { email: string; name: string },
  invitePageUrl: string,
  unsubscribeUrl: string,
  locale = "en",
): Promise<TransactionalEmail> {
  const say = emailText(locale);
  return message(
    user.email,
    locale,
    say("Invite a friend"),
    <>
      <Text>{greeting(say, user.name)}</Text>
      <Text>
        {say(
          "Invite a friend to Ork: they get {weeks} weeks free, and you earn a free month when they start a qualifying subscription with a new card.",
          { weeks: INVITED_TRIAL_WEEKS },
        )}{" "}
        <Link href={invitePageUrl} style={linkStyle}>
          {say("Open Ork")}
        </Link>{" "}
        {say("and choose Invite friends for your link.")}
      </Text>
      <Text>{say("Have any questions? Just reply to this email.")}</Text>
      <Text>
        {say("If you're enjoying Ork,")}{" "}
        <Link href="https://github.com/orkbot-run/ork" style={linkStyle}>
          {say("give us a star on GitHub")}
        </Link>
        .
      </Text>
      <Text>Ork</Text>
    </>,
    unsubscribeUrl,
  );
}
