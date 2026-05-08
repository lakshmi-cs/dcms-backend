const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config();

const { ping, query } = require("./db");
const {
  ACTIVE,
  AppError,
  createOrder,
  expireCoupons,
  generateCoupon,
  getActiveCoupons,
  getAnalyticsSummary,
  getCouponByCode,
  getEconomyFoodItems,
  getLatestCouponForStudent,
  getStudentById,
  listCoupons,
  redeemCoupon,
} = require("./services/couponModuleService");

function createApp() {
  const app = express();

  app.use(cors());
  app.use(bodyParser.json());

  app.get("/health", async (_req, res, next) => {
    try {
      await ping();
      await expireCoupons();
      res.json({
        status: "success",
        data: {
          service: "dcms-backend",
          database: "connected",
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/login", async (req, res, next) => {
    const { studentId, password } = req.body;

    try {
      const student = await getStudentById(studentId);
      if (!student) {
        throw new AppError(401, "Invalid credentials");
      }

      const rows = await query(
        "SELECT student_id, student_name, credit_balance FROM users WHERE student_id = ? AND password = ? LIMIT 1",
        [studentId, password],
      );

      if (!rows.length) {
        throw new AppError(401, "Invalid credentials");
      }

      res.json({
        status: "success",
        data: rows[0],
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/register", async (req, res, next) => {
    const { studentId, password, studentName } = req.body;

    try {
      if (!studentId || !password) {
        throw new AppError(400, "Student ID and password are required.");
      }

      const existing = await query("SELECT student_id FROM users WHERE student_id = ? LIMIT 1", [studentId]);
      if (existing.length) {
        throw new AppError(409, "Student ID already registered.");
      }

      await query(
        `
          INSERT INTO users (student_id, password, student_name, credit_balance)
          VALUES (?, ?, ?, ?)
        `,
        [studentId, password, studentName || "New Student", 0],
      );

      res.status(201).json({
        status: "success",
        message: "User registered successfully",
      });
    } catch (error) {
      next(error);
    }
