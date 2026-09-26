const nodemailer = require('nodemailer');

async function sendTestEmail() {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD
    }
  });

  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_USER,
    subject: 'Test SellFlow AI',
    text: 'Félicitations ! SellFlow AI peut maintenant envoyer des emails.',
    html: `
      <div style="font-family:Arial,sans-serif">
        <h2>SellFlow AI</h2>
        <p>Félicitations 🎉</p>
        <p>L'envoi d'emails depuis le backend fonctionne correctement.</p>
      </div>
    `
  });

  console.log('Email envoyé :', info.messageId);
}

sendTestEmail().catch((error) => {
  console.error('Erreur email :', error);
  process.exit(1);
});
