const jwt = require('jsonwebtoken');

// Startup guard — same as admin auth
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 characters.');
  process.exit(1);
}

module.exports = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = header.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // Must have customerId claim — rejects admin tokens which have adminId instead
    if (!decoded.customerId) {
      return res.status(401).json({ error: 'Invalid token claims' });
    }

    req.customerId = decoded.customerId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
};
