
  return rows;
}

function getRecentDateKeys(totalDays) {
  return Array.from({ length: totalDays }, (_, index) => {
    const date = new Date(Date.now() - (totalDays - index - 1) * 24 * 60 * 60 * 1000);
    return getZonedNowParts(date).date;
  });
}

async function getDashboardAnalytics(selectedDate, mealWindows) {
  const trendDates = getRecentDateKeys(7);
  const rangeStart = trendDates[0];
  const rangeEnd = trendDates[trendDates.length - 1];

  const [
    totalStudentsRows,
    activeStudentsRows,
    mealBreakdownRows,
    couponBreakdownRows,
    trendRows,
  ] = await Promise.all([
    dbQuery('SELECT COUNT(*) AS total FROM users'),
    dbQuery('SELECT COUNT(DISTINCT student_id) AS total FROM coupon_redemptions WHERE DATE(issued_at) = ?', [selectedDate]),
    dbQuery(
      `
        SELECT meal_code AS mealCode, COUNT(*) AS total
        FROM coupon_redemptions
        WHERE DATE(issued_at) = ?
        GROUP BY meal_code
      `,
      [selectedDate],
    ),
    dbQuery(
      `
        SELECT coupon_type AS couponType, COUNT(*) AS total
        FROM coupon_redemptions
        WHERE DATE(issued_at) = ?
        GROUP BY coupon_type
      `,
      [selectedDate],
    ),
    dbQuery(
      `
        SELECT
          DATE_FORMAT(issued_at, '%Y-%m-%d') AS activityDate,
          COUNT(*) AS couponsIssued,
          COUNT(DISTINCT student_id) AS studentsServed
        FROM coupon_redemptions
        WHERE DATE(issued_at) BETWEEN ? AND ?
        GROUP BY DATE(issued_at)
        ORDER BY activityDate ASC
      `,
      [rangeStart, rangeEnd],
    ),
  ]);

  const mealTotals = new Map(
    mealBreakdownRows.map((row) => [row.mealCode, Number(row.total || 0)]),
  );
  const couponTotals = new Map(
    couponBreakdownRows.map((row) => [String(row.couponType || ''), Number(row.total || 0)]),
  );
  const trendTotals = new Map(
    trendRows.map((row) => [
      String(row.activityDate),
      {
        couponsIssued: Number(row.couponsIssued || 0),
        studentsServed: Number(row.studentsServed || 0),
      },
    ]),
  );

  return {
    registeredStudents: Number(totalStudentsRows[0]?.total || 0),
    activeStudentsToday: Number(activeStudentsRows[0]?.total || 0),
    mealBreakdown: mealWindows.map((window) => ({
      mealCode: window.mealCode,
      mealName: window.mealName,
      total: Number(mealTotals.get(window.mealCode) || 0),
    })),
    couponBreakdown: [
      { couponType: 'Economy', total: Number(couponTotals.get('Economy') || 0) },
      { couponType: 'Coupon', total: Number(couponTotals.get('Coupon') || 0) },
    ],
    weeklyTrend: trendDates.map((activityDate) => ({
      activityDate,
      couponsIssued: Number(trendTotals.get(activityDate)?.couponsIssued || 0),
      studentsServed: Number(trendTotals.get(activityDate)?.studentsServed || 0),
    })),
  };
}

async function buildAppPayload(studentId) {
  const now = getZonedNowParts();
  const [mealWindows, menus, news] = await Promise.all([
      dbQuery('SELECT COUNT(*) AS total FROM coupon_redemptions WHERE DATE(issued_at) = ?', [now.date]),
      dbQuery('SELECT COUNT(*) AS total FROM coupon_redemptions WHERE DATE(redeemed_at) = ?', [now.date]),
    ]);
    const analytics = await getDashboardAnalytics(now.date, mealWindows);

    res.json({
      status: 'success',
          publishedNews: news.filter((item) => item.status === 'published').length,
          qrIssuedToday: Number(issuedSummaryRows[0]?.total || 0),
          qrRedeemedToday: Number(redeemedSummaryRows[0]?.total || 0),
          registeredStudents: analytics.registeredStudents,
          activeStudentsToday: analytics.activeStudentsToday,
        },
        analytics,
        mealWindows,
        menus,
        news: news.slice(0, 8),
