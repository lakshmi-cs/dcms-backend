-- DCMS coupon-based food redemption module
-- TiDB / MySQL compatible schema additions
-- The existing `users` table in your screenshot is used as the student master table.

-- Mobile app coupon-redemption add-on storage.
-- The student app coupon flow stores Economy coupon add-ons in JSON form.
ALTER TABLE coupon_redemptions
  ADD COLUMN IF NOT EXISTS add_ons JSON NULL;

CREATE TABLE IF NOT EXISTS food_items (
  food_item_id BIGINT PRIMARY KEY AUTO_INCREMENT,
  item_name VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  category ENUM('ECONOMY_FOOD', 'REGULAR_FOOD') NOT NULL DEFAULT 'ECONOMY_FOOD',
  price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  is_available TINYINT(1) NOT NULL DEFAULT 1,
  available_from TIME NULL,
  available_until TIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_food_items_category_available (category, is_available)
);

CREATE TABLE IF NOT EXISTS orders (
  order_id BIGINT PRIMARY KEY AUTO_INCREMENT,
  student_id VARCHAR(50) NOT NULL,
  food_item_id BIGINT NOT NULL,
  order_type ENUM('ECONOMY_FOOD') NOT NULL DEFAULT 'ECONOMY_FOOD',
  payment_status ENUM('PAID', 'FAILED', 'REFUNDED') NOT NULL DEFAULT 'PAID',
  price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  claim_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (student_id) REFERENCES users(student_id),
  CONSTRAINT fk_orders_food FOREIGN KEY (food_item_id) REFERENCES food_items(food_item_id),
  UNIQUE KEY uq_student_daily_economy_claim (student_id, order_type, claim_date),
  INDEX idx_orders_created_at (created_at),
  INDEX idx_orders_food_item (food_item_id)
);

CREATE TABLE IF NOT EXISTS coupons (
  coupon_id BIGINT PRIMARY KEY AUTO_INCREMENT,
  coupon_code VARCHAR(20) NOT NULL,
  student_id VARCHAR(50) NOT NULL,
  order_id BIGINT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  redeemed_at DATETIME NULL,
  redeemed_by VARCHAR(100) NULL,
  status ENUM('ACTIVE', 'REDEEMED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT fk_coupons_user FOREIGN KEY (student_id) REFERENCES users(student_id),
  CONSTRAINT fk_coupons_order FOREIGN KEY (order_id) REFERENCES orders(order_id),
  UNIQUE KEY uq_coupons_code (coupon_code),
  UNIQUE KEY uq_coupon_order (order_id),
  INDEX idx_coupon_student_status (student_id, status),
  INDEX idx_coupon_expiry_status (expires_at, status)
);

INSERT INTO food_items (item_name, description, category, price, is_available, available_from, available_until)
VALUES
  ('Economy Rice Set A', 'Rice, vegetables, and curry chicken', 'ECONOMY_FOOD', 5.00, 1, '11:00:00', '14:30:00'),
  ('Economy Rice Set B', 'Rice, tofu, egg, and vegetables', 'ECONOMY_FOOD', 4.50, 1, '11:00:00', '14:30:00'),
  ('Economy Noodles', 'Stir-fried noodles with mixed vegetables', 'ECONOMY_FOOD', 4.00, 1, '11:00:00', '14:30:00')
ON DUPLICATE KEY UPDATE
  item_name = VALUES(item_name);
