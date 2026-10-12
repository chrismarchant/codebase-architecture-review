import nodemailer, { type Transporter } from 'nodemailer';

/** The subset of a nodemailer transporter the service uses. Tests substitute a fake. */
export type Mailer = Pick<Transporter, 'sendMail'>;

/** SMTP connection URL, for example smtp://user:pass@smtp.example.test:587 */
export function createMailer(smtpUrl: string): Mailer {
  return nodemailer.createTransport(smtpUrl);
}
