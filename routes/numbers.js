const router = require('express').Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');

router.use(auth);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.*, c.name as customer_name
       FROM whatsapp_numbers n
       LEFT JOIN customers c ON c.id = n.customer_id
       ORDER BY n.created_at DESC`
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

router.post('/', async (req, res) => {
  const { number } = req.body;
  if (!number) return res.status(400).json({ error: 'number required' });
  try {
    const result = await pool.query(
      'INSERT INTO whatsapp_numbers (number) VALUES ($1) RETURNING *', [number]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Number already exists' });
    res.status(500).json({ error: 'Failed' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM whatsapp_numbers WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

module.exports = router;
