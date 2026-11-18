-- LINE受信側の確定JSONに合わせる。過去の固定本文は変更しない。
DROP TRIGGER enqueue_line_request_created;

CREATE TRIGGER enqueue_line_request_created AFTER INSERT ON event_logs
WHEN NEW.event_type = 'request.created'
BEGIN
  INSERT INTO line_outbox(event_id,request_id,body_json)
  SELECT CAST(NEW.event_log_id AS TEXT),r.request_id,
    json_object('event_id',CAST(NEW.event_log_id AS TEXT),
      'event_type','request.created',
      'request',json_object('request_id',r.request_id,
        'borrower_display_name',u.name,'status',r.status))
  FROM rental_requests r JOIN users u ON u.student_id=r.borrower_student_id
  WHERE r.request_id=NEW.entity_id;
END;
