const express = require('express');
const { authenticateNfcDevice } = require('../nfc/device-auth');
const { createNfcRentalRequest } = require('../nfc/request-service');
const { validateRequestBody } = require('../nfc/validation');
const { HttpError } = require('./errors');
const { requireHttps: httpsMiddleware } = require('./middleware');
const { invalidRequest, validateEventId } = require('./validation');
const { getRequest, publicRequest } = require('../rental/queries');
const { cancel, cardStudent } = require('../rental/service');
const { normalizeCardUid } = require('../nfc/validation');
const { unlockForHttpReader } = require('../rental/card-unlock');

function createNfcRouter(db, { requireHttps }) {
  const router = express.Router();
  const authenticate = authenticateNfcDevice(db);

  router.post(
    '/lock-reader/taps',
    httpsMiddleware(requireHttps),
    authenticate,
    express.json({ limit: '16kb' }),
    (req, res) => {
      const result = unlockForHttpReader(db, { deviceId: req.auth.deviceId, body: req.body });
      res.status(result.created ? 201 : 200).json(result.response);
    },
  );

  router.post(
    '/requests',
    httpsMiddleware(requireHttps, 'このAPIはHTTPSでのみ利用できます'),
    authenticate,
    express.json({ limit: '16kb' }),
    (req, res, next) => {
      try {
        const body = validateRequestBody(req.body);
        const result = createNfcRentalRequest(db, {
          ...body,
          deviceId: req.auth.deviceId,
        });
        return res.status(result.created ? 201 : 200).json(result.response);
      } catch (error) {
        return next(error);
      }
    },
  );

  router.get('/requests/:id', httpsMiddleware(requireHttps), authenticate, (req, res) => {
    const row = getRequest(db, req.params.id);
    if (row.source_device_id !== req.auth.deviceId) {
      throw new HttpError(404, 'REQUEST_NOT_FOUND', '申請が見つかりません');
    }
    res.json(publicRequest(row));
  });

  router.post(
    '/requests/:id/cancel',
    httpsMiddleware(requireHttps),
    authenticate,
    express.json({ limit: '16kb' }),
    (req, res) => {
      const body = req.body;
      if (!body || Object.keys(body).some((key) => !['card_uid', 'event_id'].includes(key))) {
        invalidRequest();
      }
      res.json(
        cancel(db, {
          id: req.params.id,
          studentId: cardStudent(db, normalizeCardUid(body.card_uid)),
          eventId: validateEventId(body.event_id),
          source: `nfc:${req.auth.deviceId}`,
        }),
      );
    },
  );

  return router;
}

module.exports = { createNfcRouter };
