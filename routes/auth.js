const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');

const { getPool } = require('../config/database');

const {
hashPassword,
comparePassword,
signToken,
authMiddleware
} = require('../utils/auth');

const router = express.Router();

const pool = getPool();

/* =========================================================
CONFIGURATION
========================================================= */

const FRONTEND_URL =
process.env.FRONTEND_URL ||
'https://sellflowic.netlify.app';

const BACKEND_URL =
process.env.BACKEND_URL ||
'https://sellflow-backend.onrender.com';

const GOOGLE_CLIENT_ID =
process.env.GOOGLE_CLIENT_ID || '';

const GOOGLE_CLIENT_SECRET =
process.env.GOOGLE_CLIENT_SECRET || '';

const GOOGLE_REDIRECT_URI =
process.env.GOOGLE_REDIRECT_URI ||
`${BACKEND_URL}/auth/gmail/callback`;

/* =========================================================
HELPERS
========================================================= */

/*

* Normalisation obligatoire des e-mails.
*
* Exemple :
* " [Test@Email.COM](mailto:Test@Email.COM) "
* devient :
* "[test@email.com](mailto:test@email.com)"
  */
  function normalizeEmail(email) {
  return String(email || '')
  .trim()
  .toLowerCase();
  }

/*

* Vérification simple de l'adresse e-mail.
  */
  function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+.[^\s@]+$/.test(
  email
  );
  }

/*

* Réponse publique utilisateur.
*
* Ne jamais envoyer le mot de passe au frontend.
  */
  function publicUser(user) {
  if (!user) {
  return null;
  }

return {
id: user.id,
name: user.name,
email: user.email,
phone: user.phone || null,
country: user.country || null,
plan: user.plan || 'free',
email_verified:
user.email_verified !== false,
subscription_status:
user.subscription_status || null,
subscription_started_at:
user.subscription_started_at || null,
subscription_expires_at:
user.subscription_expires_at || null,
created_at:
user.created_at || null,
updated_at:
user.updated_at || null
};
}

/*

* Recherche d'un utilisateur avec e-mail normalisé.
  */
  async function findUserByEmail(email) {
  const normalizedEmail =
  normalizeEmail(email);

if (!normalizedEmail) {
return null;
}

const result = await pool.query(
`       SELECT *
      FROM users
      WHERE LOWER(TRIM(email)) = $1
      LIMIT 1
    `,
[normalizedEmail]
);

return result.rows[0] || null;
}

/*

* Vérifie si un e-mail existe déjà.
  */
  async function emailExists(email) {
  const user =
  await findUserByEmail(email);

return Boolean(user);
}

/*

* Création centralisée d'un utilisateur.
*
* IMPORTANT :
* * UUID généré par PostgreSQL
* * e-mail déjà normalisé
* * email_verified = TRUE
* * aucune vérification par e-mail
    */
    async function createUser({
    name,
    email,
    phone,
    country,
    passwordHash,
    plan = 'free'
    }) {
    const normalizedEmail =
    normalizeEmail(email);

const result = await pool.query(
`       INSERT INTO users (
        id,
        name,
        email,
        phone,
        country,
        password_hash,
        email_verified,
        plan
      )
      VALUES (
        gen_random_uuid(),
        $1,
        $2,
        $3,
        $4,
        $5,
        TRUE,
        $6
      )
      RETURNING *
    `,
[
String(name || '').trim(),
normalizedEmail,
phone ? String(phone).trim() : null,
country ? String(country).trim() : null,
passwordHash,
plan
]
);

return result.rows[0];
}

/*

* Réponse standard pour un e-mail déjà utilisé.
  */
  function emailAlreadyExistsResponse(res) {
  return res.status(409).json({
  ok: false,
  code: 'EMAIL_ALREADY_EXISTS',
  message:
  'Cette adresse e-mail est déjà utilisée par un compte.'
  });
  }

/*

* Validation commune inscription.
  */
  function validateRegistrationData(body) {
  const name =
  String(body.name || '').trim();

const email =
normalizeEmail(body.email);

const password =
String(body.password || '');

const phone =
body.phone
? String(body.phone).trim()
: null;

const country =
body.country
? String(body.country).trim()
: null;

if (!name) {
return {
valid: false,
status: 400,
message:
'Le nom est obligatoire.'
};
}

if (!email || !isValidEmail(email)) {
return {
valid: false,
status: 400,
message:
'Veuillez fournir une adresse e-mail valide.'
};
}

if (password.length < 6) {
return {
valid: false,
status: 400,
message:
'Le mot de passe doit contenir au moins 6 caractères.'
};
}

return {
valid: true,
data: {
name,
email,
phone,
country,
password
}
};
}

/* =========================================================
INSCRIPTION — VERSION COMPLETE
========================================================= */

router.post(
'/register/complete',
async function (req, res) {
try {
const validation =
validateRegistrationData(req.body);

```
  if (!validation.valid) {
    return res.status(
      validation.status
    ).json({
      ok: false,
      message:
        validation.message
    });
  }

  const {
    name,
    email,
    phone,
    country,
    password
  } = validation.data;

  /*
   * Première vérification.
   */
  if (
    await emailExists(email)
  ) {
    return emailAlreadyExistsResponse(
      res
    );
  }

  const passwordHash =
    await hashPassword(password);

  let user;

  try {
    user = await createUser({
      name,
      email,
      phone,
      country,
      passwordHash,
      plan: 'free'
    });
  } catch (error) {
    /*
     * Protection contre les inscriptions
     * simultanées avec le même e-mail.
     */
    if (
      error &&
      error.code === '23505'
    ) {
      return emailAlreadyExistsResponse(
        res
      );
    }

    throw error;
  }

  const token =
    signToken(user);

  return res.status(201).json({
    ok: true,

    message:
      'Compte créé avec succès.',

    token,

    user:
      publicUser(user)
  });

} catch (error) {
  console.error(
    '❌ Erreur register/complete:',
    error
  );

  return res.status(
    500
  ).json({
    ok: false,

    error:
      'REGISTER_ERROR',

    message:
      'Impossible de créer le compte.'
  });
}
```

}
);

/* =========================================================
INSCRIPTION CLASSIQUE
========================================================= */

router.post(
'/register',
async function (req, res) {
try {
const validation =
validateRegistrationData(req.body);

```
  if (!validation.valid) {
    return res.status(
      validation.status
    ).json({
      ok: false,
      message:
        validation.message
    });
  }

  const {
    name,
    email,
    phone,
    country,
    password
  } = validation.data;

  /*
   * Une seule adresse e-mail = un seul compte.
   */
  if (
    await emailExists(email)
  ) {
    return emailAlreadyExistsResponse(
      res
    );
  }

  const passwordHash =
    await hashPassword(password);

  let user;

  try {
    user = await createUser({
      name,
      email,
      phone,
      country,
      passwordHash,
      plan: 'free'
    });
  } catch (error) {
    if (
      error &&
      error.code === '23505'
    ) {
      return emailAlreadyExistsResponse(
        res
      );
    }

    throw error;
  }

  const token =
    signToken(user);

  return res.status(201).json({
    ok: true,

    message:
      'Compte créé avec succès.',

    token,

    user:
      publicUser(user)
  });

} catch (error) {
  console.error(
    '❌ Erreur register:',
    error
  );

  return res.status(
    500
  ).json({
    ok: false,

    error:
      'REGISTER_ERROR',

    message:
      'Impossible de créer le compte.'
  });
}
```

}
);

/* =========================================================
CONNEXION
========================================================= */

router.post(
'/login',
async function (req, res) {
try {
const email =
normalizeEmail(
req.body.email
);

```
  const password =
    String(
      req.body.password || ''
    );

  if (
    !email ||
    !isValidEmail(email)
  ) {
    return res.status(400).json({
      ok: false,

      message:
        'Veuillez fournir une adresse e-mail valide.'
    });
  }

  if (!password) {
    return res.status(400).json({
      ok: false,

      message:
        'Le mot de passe est obligatoire.'
    });
  }

  const user =
    await findUserByEmail(email);

  if (!user) {
    return res.status(401).json({
      ok: false,

      code:
        'INVALID_CREDENTIALS',

      message:
        'E-mail ou mot de passe incorrect.'
    });
  }

  if (
    !user.password_hash
  ) {
    return res.status(401).json({
      ok: false,

      code:
        'GOOGLE_ACCOUNT',

      message:
        'Ce compte utilise la connexion Google. Utilisez le bouton Google pour vous connecter.'
    });
  }

  const passwordValid =
    await comparePassword(
      password,
      user.password_hash
    );

  if (!passwordValid) {
    return res.status(401).json({
      ok: false,

      code:
        'INVALID_CREDENTIALS',

      message:
        'E-mail ou mot de passe incorrect.'
    });
  }

  const token =
    signToken(user);

  return res.json({
    ok: true,

    message:
      'Connexion réussie.',

    token,

    user:
      publicUser(user)
  });

} catch (error) {
  console.error(
    '❌ Erreur login:',
    error
  );

  return res.status(
    500
  ).json({
    ok: false,

    error:
      'LOGIN_ERROR',

    message:
      'Impossible de se connecter.'
  });
}
```

}
);

/* =========================================================
UTILISATEUR CONNECTÉ
========================================================= */

router.get(
'/me',
authMiddleware,
async function (req, res) {
try {
const userId =
req.user &&
(req.user.id ||
req.user.userId ||
req.user.sub);

```
  if (!userId) {
    return res.status(401).json({
      ok: false,

      message:
        'Utilisateur non authentifié.'
    });
  }

  const result =
    await pool.query(
      `
        SELECT *
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );

  if (
    result.rows.length === 0
  ) {
    return res.status(404).json({
      ok: false,

      message:
        'Compte introuvable.'
    });
  }

  return res.json({
    ok: true,

    user:
      publicUser(
        result.rows[0]
      )
  });

} catch (error) {
  console.error(
    '❌ Erreur /me:',
    error
  );

  return res.status(
    500
  ).json({
    ok: false,

    error:
      'ME_ERROR',

    message:
      'Impossible de récupérer le compte.'
  });
}
```

}
);

/* =========================================================
GOOGLE / GMAIL
========================================================= */

function createGoogleClient() {
if (
!GOOGLE_CLIENT_ID ||
!GOOGLE_CLIENT_SECRET
) {
return null;
}

return new google.auth.OAuth2(
GOOGLE_CLIENT_ID,
GOOGLE_CLIENT_SECRET,
GOOGLE_REDIRECT_URI
);
}

/* =========================================================
GOOGLE CONNECT
========================================================= */

router.get(
'/gmail/connect',
function (req, res) {
try {
const client =
createGoogleClient();

```
  if (!client) {
    return res.status(500).json({
      ok: false,

      error:
        'GOOGLE_NOT_CONFIGURED',

      message:
        'La connexion Google n’est pas configurée sur le backend.'
    });
  }

  const url =
    client.generateAuthUrl({
      access_type: 'offline',

      prompt: 'select_account',

      scope: [
        'openid',
        'profile',
        'email'
      ]
    });

  return res.redirect(url);

} catch (error) {
  console.error(
    '❌ Erreur Gmail connect:',
    error
  );

  return res.status(
    500
  ).json({
    ok: false,

    message:
      'Impossible de démarrer la connexion Google.'
  });
}
```

}
);

/* =========================================================
GOOGLE CALLBACK
========================================================= */

router.get(
'/gmail/callback',
async function (req, res) {
try {
const code =
String(
req.query.code || ''
).trim();

```
  if (!code) {
    return res.redirect(
      FRONTEND_URL +
      '/#google-auth-error'
    );
  }

  const client =
    createGoogleClient();

  if (!client) {
    return res.redirect(
      FRONTEND_URL +
      '/#google-auth-error'
    );
  }

  const tokenResponse =
    await client.getToken(code);

  client.setCredentials(
    tokenResponse.tokens
  );

  const oauth2 =
    google.oauth2({
      auth: client,
      version: 'v2'
    });

  const userInfoResponse =
    await oauth2.userinfo.get();

  const googleUser =
    userInfoResponse.data;

  const googleEmail =
    normalizeEmail(
      googleUser.email
    );

  if (
    !googleEmail ||
    !isValidEmail(
      googleEmail
    )
  ) {
    return res.redirect(
      FRONTEND_URL +
      '/#google-auth-error'
    );
  }

  /*
   * IMPORTANT :
   * On cherche d'abord l'adresse e-mail.
   *
   * Si le compte existe déjà :
   * on réutilise ce compte.
   *
   * Google ne crée donc pas un deuxième
   * compte avec la même adresse.
   */
  let user =
    await findUserByEmail(
      googleEmail
    );

  if (!user) {
    /*
     * Création d'un compte Google.
     *
     * On génère un mot de passe aléatoire
     * uniquement parce que la colonne
     * password_hash peut être obligatoire
     * dans certaines installations.
     */
    const randomPassword =
      crypto.randomBytes(32)
        .toString('hex');

    const passwordHash =
      await hashPassword(
        randomPassword
      );

    try {
      user =
        await createUser({
          name:
            String(
              googleUser.name ||
              googleUser.given_name ||
              'Utilisateur SellFlow'
            ).trim(),

          email:
            googleEmail,

          phone:
            null,

          country:
            null,

          passwordHash,

          plan:
            'free'
        });
    } catch (error) {
      /*
       * Cas de course :
       * quelqu'un a créé le même compte
       * entre notre SELECT et INSERT.
       */
      if (
        error &&
        error.code === '23505'
      ) {
        user =
          await findUserByEmail(
            googleEmail
          );
      } else {
        throw error;
      }
    }
  }

  if (!user) {
    return res.redirect(
      FRONTEND_URL +
      '/#google-auth-error'
    );
  }

  const token =
    signToken(user);

  /*
   * Le token est transmis au frontend.
   *
   * Le frontend peut ensuite récupérer /auth/me.
   */
  return res.redirect(
    FRONTEND_URL +
    '/#google-auth-success?token=' +
    encodeURIComponent(token)
  );

} catch (error) {
  console.error(
    '❌ Erreur Gmail callback:',
    error
  );

  return res.redirect(
    FRONTEND_URL +
    '/#google-auth-error'
  );
}
```

}
);

/* =========================================================
ROUTE DE TEST
========================================================= */

router.get(
'/status',
function (req, res) {
return res.json({
ok: true,

```
  service:
    'SellFlow authentication',

  version:
    'auth-2.0',

  emailVerification:
    'disabled',

  uniqueEmail:
    'enabled',

  googleAuth:
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET
      ? 'configured'
      : 'not-configured',

  resend:
    'disabled'
});
```

}
);

module.exports = router;
