import Presentation from "../models/presentation.model.js";
import Examiner from "../models/examiner.model.js";
import Venue from "../models/venue.model.js";
import Student from "../models/student.model.js";
import RescheduleRequest from "../models/reschedule.model.js";
import mongoose from "mongoose";
import Timetable from "../models/timetable.model.js";
import { rescheduleLectures } from "./lecReschedule.controller.js";
import { sendEmail } from "../utils/emailSender.js";
import Joi from "joi";
import sanitize from "mongo-sanitize";

// ------------------------------
// Helpers
// ------------------------------
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);
const isHHMM = (s) => /^\d{2}:\d{2}$/.test(s);
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s); // keep YYYY-MM-DD

// ------------------------------
// Validation Schemas
// ------------------------------
const presentationSchema = Joi.object({
  title: Joi.string().min(3).max(100).required(),
  students: Joi.array().items(Joi.string().hex().length(24)).required(),
  examiners: Joi.array().items(Joi.string().hex().length(24)).required(),
  venue: Joi.string().hex().length(24).required(),
  department: Joi.string().min(2).max(100).required(),
  numOfExaminers: Joi.number().integer().min(1).required(),
  date: Joi.string().custom((v, h) => (isISODate(v) ? v : h.error(new Error("date must be YYYY-MM-DD")))).required(),
  duration: Joi.number().integer().min(1).required(),
  timeRange: Joi.object({
    startTime: Joi.string().custom((v, h) => (isHHMM(v) ? v : h.error(new Error("startTime must be HH:MM")))).required(),
    endTime: Joi.string().custom((v, h) => (isHHMM(v) ? v : h.error(new Error("endTime must be HH:MM")))).required(),
  }).required(),
});

const updateSchema = presentationSchema.fork(
  Object.keys(presentationSchema.describe().keys),
  (field) => field.optional()
);

// Used by /checkAvailability (it takes department ids by *codes* and venue by venue_id string)
const availabilitySchema = Joi.object({
  date: Joi.string().custom((v, h) => (isISODate(v) ? v : h.error(new Error("date must be YYYY-MM-DD")))).required(),
  department: Joi.string().min(2).max(100).required(),
  students: Joi.array().items(Joi.string().min(1)).required(),  // student_id strings
  examiners: Joi.array().items(Joi.string().min(1)).required(), // examiner_id strings
  venue: Joi.string().min(1).required(),                        // venue_id string
  duration: Joi.number().integer().min(1).required(),
});

const smartSuggestSchema = Joi.object({
  studentIds: Joi.array().items(Joi.string().hex().length(24)).required(),
  numExaminers: Joi.number().integer().min(1).required(),
  duration: Joi.number().integer().min(1).required(),
});

const rescheduleSuggestSchema = Joi.object({
  presentationId: Joi.string().hex().length(24).required(),
});

// ------------------------------
// Time-slot clash check (reused)
// ------------------------------
const isTimeSlotAvailable = async (date, startTime, endTime, examiners, venue, students) => {
  // SECURITY: ensure sanitized primitives (no $ operators)
  date = sanitize(date);
  startTime = sanitize(startTime);
  endTime = sanitize(endTime);

  // SECURITY: ensure arrays are ObjectId strings only (if provided)
  const exArr = Array.isArray(examiners) ? examiners.filter(isObjectId) : [];
  const stArr = Array.isArray(students) ? students.filter(isObjectId) : [];
  const venueId = venue && isObjectId(venue) ? venue : null;

  const timeOverlap = [
    { "timeRange.startTime": { $lt: endTime }, "timeRange.endTime": { $gt: startTime } },
    { "timeRange.startTime": { $gte: startTime, $lt: endTime } },
    { "timeRange.endTime": { $gt: startTime, $lte: endTime } },
  ];

  const overlappingExaminer = exArr.length
    ? await Presentation.findOne({ date, examiners: { $in: exArr }, $or: timeOverlap })
    : null;

  const overlappingVenue = venueId
    ? await Presentation.findOne({ date, venue: venueId, $or: timeOverlap })
    : null;

  const overlappingStudent = stArr.length
    ? await Presentation.findOne({ date, students: { $in: stArr }, $or: timeOverlap })
    : null;

  return !overlappingExaminer && !overlappingVenue && !overlappingStudent;
};

// ------------------------------
// Controllers
// ------------------------------

export const addPresentation = async (req, res, next) => {
  try {
    // SECURITY: sanitize + validate
    const cleanBody = sanitize(req.body);
    const { error, value } = presentationSchema.validate(cleanBody);
    if (error) return res.status(400).json({ message: error.message });

    const {
      title, students, examiners, venue,
      department, numOfExaminers, date, duration, timeRange
    } = value;

    // SECURITY: verify ObjectIds again (defense-in-depth)
    if (!students.every(isObjectId) || !examiners.every(isObjectId) || !isObjectId(venue)) {
      return res.status(400).json({ message: "Invalid ObjectId in students/examiners/venue" });
    }

    // 1️⃣ Check time-slot availability
    const available = await isTimeSlotAvailable(
      date, timeRange.startTime, timeRange.endTime, examiners, venue, students
    );
    if (!available) {
      return res.status(400).json({ message: "Selected time slot is not available" });
    }

    // 2️⃣ Create presentation
    const newPresentation = new Presentation({
      title, students, examiners, venue,
      department, numOfExaminers, date, duration, timeRange
    });
    await newPresentation.save();

    // 3️⃣ Email notifications
    try {
      const examinerDocs = await Examiner.find({ _id: { $in: examiners } }).select("email");
      const studentDocs  = await Student.find({ _id: { $in: students } }).select("email");
      const venueDoc     = await Venue.findById(newPresentation.venue).select("venue_id");

      if (!venueDoc) return res.status(404).json({ message: "Venue not found" });
      const actualVenueId = venueDoc.venue_id;

      for (const exDoc of examinerDocs) {
        if (exDoc?.email) {
          await sendEmail(
            exDoc.email,
            "New Presentation Scheduled",
            `Dear Examiner,

A new presentation has been scheduled:
Title: ${title}
Department: ${department}
Date: ${date}
Time: ${timeRange.startTime} - ${timeRange.endTime}
Venue: ${actualVenueId}

Please be prepared accordingly.`
          );
        }
      }

      for (const stDoc of studentDocs) {
        if (stDoc?.email) {
          await sendEmail(
            stDoc.email,
            "New Presentation Scheduled",
            `Dear Student,

A new presentation has been scheduled:
Title: ${title}
Department: ${department}
Date: ${date}
Time: ${timeRange.startTime} - ${timeRange.endTime}
Venue: ${actualVenueId}

Please be prepared accordingly.`
          );
        }
      }
    } catch (emailError) {
      console.error("Error sending email notifications:", emailError);
    }

    // 4️⃣ Reschedule other lectures for each examiner on this date
    for (const examinerObjectId of examiners) {
      try {
        const examiner = await Examiner.findById(examinerObjectId).select("examiner_id");
        if (!examiner) continue;

        const fakeReq = { body: { lecturerId: examiner.examiner_id, date } };
        const fakeRes = { status: () => ({ json: () => {} }) };
        await rescheduleLectures(fakeReq, fakeRes);
      } catch (err) {
        console.log("Reschedule response for Examiner:", examiner.examiner_id, response);
      }
    }

    res.status(201).json({
      message: "Presentation scheduled successfully & lectures rescheduled",
      newPresentation,
    });
  } catch (error) {
    console.error("Error in addPresentation:", error);
    next(error);
  }
};

export const checkAvailability = async (req, res, next) => {
  try {
    // SECURITY: sanitize + validate (this endpoint uses domain IDs, not ObjectIds)
    const cleanBody = sanitize(req.body);
    const { error, value } = availabilitySchema.validate(cleanBody);
    if (error) return res.status(400).json({ success: false, message: error.message });

    const { date, department, students, examiners, venue, duration } = value;

    // Map domain ids -> ObjectIds
    const studentIds = await Student.find({ student_id: { $in: students } }).select("_id");
    const examinerIds = await Examiner.find({ examiner_id: { $in: examiners } }).select("_id");
    const venueObj = await Venue.findOne({ venue_id: venue }).select("_id");

    if (!studentIds?.length || !examinerIds?.length || !venueObj?._id) {
      return res.status(400).json({ success: false, message: "Invalid student/examiner/venue ID(s)" });
    }

    const studentObjectIds = studentIds.map((s) => s._id);
    const examinerObjectIds = examinerIds.map((e) => e._id);
    const venueObjectId = venueObj._id;

    // Fetch existing presentations for conflict overview
    const presentations = await Presentation.find({
      date,
      department,
      venue: venueObjectId,
      $or: [
        { students: { $in: studentObjectIds } },
        { examiners: { $in: examinerObjectIds } },
      ],
    }).select("timeRange");

    if (presentations.length === 0) {
      return res.status(200).json([{ timeSlot: "08:00 - 18:00", available: true }]);
    }

    const toMinutes = (t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    };
    const toTime = (mins) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

    const unavailable = presentations.map((p) => ({
      start: toMinutes(p.timeRange.startTime),
      end: toMinutes(p.timeRange.endTime),
    })).sort((a, b) => a.start - b.start);

    const availableSlots = [];
    let prevEnd = toMinutes("08:00");

    for (const slot of unavailable) {
      if (slot.start > prevEnd) {
        if (slot.start - prevEnd >= duration) {
          availableSlots.push({ timeSlot: `${toTime(prevEnd)} - ${toTime(slot.start)}`, available: true });
        }
      }
      prevEnd = Math.max(prevEnd, slot.end);
    }

    const dayEnd = toMinutes("18:00");
    if (prevEnd < dayEnd && dayEnd - prevEnd >= duration) {
      availableSlots.push({ timeSlot: `${toTime(prevEnd)} - ${toTime(dayEnd)}`, available: true });
    }

    return res.status(200).json(availableSlots);
  } catch (error) {
    console.error("Error in checkAvailability:", error);
    next(error);
  }
};

export const getAllPresentations = async (req, res, next) => {
  try {
    const presentations = await Presentation.find()
      .populate("students")
      .populate("examiners")
      .populate("venue");
    res.status(200).json(presentations);
  } catch (error) {
    next(error);
  }
};

export const getPresentationById = async (req, res, next) => {
  try {
    // SECURITY: validate id
    const id = sanitize(req.params.id);
    if (!isObjectId(id)) return res.status(400).json({ message: "Invalid presentation ID" });

    const presentation = await Presentation.findById(id)
      .populate("students")
      .populate("examiners")
      .populate("venue");

    if (!presentation) return res.status(404).json({ message: "Presentation not found" });
    res.status(200).json(presentation);
  } catch (error) {
    next(error);
  }
};

export const updatePresentation = async (req, res) => {
  try {
    const id = sanitize(req.params.id);
    if (!isObjectId(id)) return res.status(400).json({ message: "Invalid presentation ID" });

    // SECURITY: sanitize + validate
    const cleanBody = sanitize(req.body);
    const { error, value } = updateSchema.validate(cleanBody);
    if (error) return res.status(400).json({ message: error.message });

    // If present, hard validate ObjectIds in mutable relations
    if (value.students && !value.students.every(isObjectId)) {
      return res.status(400).json({ message: "Invalid student ObjectId(s)" });
    }
    if (value.examiners && !value.examiners.every(isObjectId)) {
      return res.status(400).json({ message: "Invalid examiner ObjectId(s)" });
    }
    if (value.venue && !isObjectId(value.venue)) {
      return res.status(400).json({ message: "Invalid venue ObjectId" });
    }

    const existing = await Presentation.findById(id);
    if (!existing) return res.status(404).json({ message: "Presentation not found" });

    // Determine if time/venue/date changed
    const date = value.date ?? existing.date;
    const timeRange = value.timeRange ?? existing.timeRange;
    const venue = value.venue ? String(value.venue) : existing.venue.toString();
    const students = value.students ?? existing.students.map(String);
    const examiners = value.examiners ?? existing.examiners.map(String);

    const isTimeChanged =
      existing.date !== date ||
      existing.timeRange.startTime !== timeRange.startTime ||
      existing.timeRange.endTime !== timeRange.endTime ||
      existing.venue.toString() !== venue;

    if (isTimeChanged) {
      const available = await isTimeSlotAvailable(
        date, timeRange.startTime, timeRange.endTime, examiners, venue, students
      );
      if (!available) {
        return res.status(400).json({ message: "Selected time slot is not available" });
      }
    }

    const updated = await Presentation.findByIdAndUpdate(id, value, { new: true });
    if (!updated) return res.status(404).json({ message: "Presentation not found after update" });

    // Email notifications after update
    try {
      const examinerDocs = await Examiner.find({ _id: { $in: examiners } }).select("email examiner_id");
      const studentDocs  = await Student.find({ _id: { $in: students } }).select("email");
      const venueDoc     = await Venue.findById(venue).select("venue_id");
      const actualVenueId = venueDoc?.venue_id ?? "UnknownVenue";

      const { title, department } = updated;
      const { startTime, endTime } = updated.timeRange;

      for (const exDoc of examinerDocs) {
        if (exDoc?.email) {
          await sendEmail(
            exDoc.email,
            "Presentation Updated",
            `Dear Examiner,

The presentation "${title}" has been updated.
Department: ${department}
New Date: ${date}
Time: ${startTime} - ${endTime}
Venue: ${actualVenueId}

Please take note of these changes.`
          );
        }
      }

      for (const stDoc of studentDocs) {
        if (stDoc?.email) {
          await sendEmail(
            stDoc.email,
            "Presentation Updated",
            `Dear Student,

Your presentation "${title}" has been updated.
Department: ${department}
New Date: ${date}
Time: ${startTime} - ${endTime}
Venue: ${actualVenueId}

Please take note of these changes.`
          );
        }
      }
    } catch (emailError) {
      console.error("Error sending email notifications:", emailError);
    }

    // Reschedule other lectures if time changed
    if (isTimeChanged) {
      for (const exId of examiners) {
        try {
          const examiner = await Examiner.findById(exId).select("examiner_id");
          if (!examiner) continue;
          const fakeReq = { body: { lecturerId: examiner.examiner_id, date } };
          const fakeRes = { status: () => ({ json: () => {} }) };
          await rescheduleLectures(fakeReq, fakeRes);
        } catch (err) {
          console.log("Reschedule response for Examiner:", examiner.examiner_id, response);
        }
      }
    }

    res.status(200).json(updated);
  } catch (error) {
    console.error("Error updating presentation:", error);
    res.status(500).json({ message: "Server error", error });
  }
};

export const deletePresentation = async (req, res) => {
  try {
    const id = sanitize(req.params.id);
    // SECURITY: validate id
    if (!isObjectId(id)) return res.status(400).json({ message: "Invalid presentation ID" });

    const deleted = await Presentation.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "Presentation not found" });
    res.status(200).json({ message: "Presentation deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

// ------------------------------
// Smart Suggest (create)
// ------------------------------
export const smartSuggestSlot = async (req, res) => {
  try {
    const cleanBody = sanitize(req.body);
    const { error, value } = smartSuggestSchema.validate(cleanBody);
    if (error) return res.status(400).json({ message: error.message });

    const { studentIds, numExaminers, duration } = value;

    const students = await Student.find({ _id: { $in: studentIds } });
    if (students.length === 0) return res.status(400).json({ message: "No valid students found" });

    const department = students[0].department;

    let departmentExaminers = await Examiner.find({ department });
    if (departmentExaminers.length === 0) {
      return res.status(400).json({ message: "No examiners found in this department" });
    }

    const allVenues = await Venue.find();
    if (allVenues.length === 0) return res.status(400).json({ message: "No venues found" });

    // Next 14 days
    const possibleDates = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      possibleDates.push(d.toISOString().split("T")[0]);
    }

    // Find date with minimum load
    let bestDate = null;
    let minLectures = Infinity;

    for (const date of possibleDates) {
      let totalLectures = 0;
      for (const examiner of departmentExaminers) {
        const lecturerSchedule = await Timetable.findOne({
          "weekdays.lecturer": examiner.examiner_id,
          "weekdays.date": date,
        });
        if (lecturerSchedule) totalLectures += lecturerSchedule.weekdays.length;
      }
      if (totalLectures < minLectures) { minLectures = totalLectures; bestDate = date; }
    }

    if (!bestDate) return res.status(400).json({ message: "No suitable date found" });

    const existingPresentations = await Presentation.find({ date: bestDate });

    const examinerVenueMap = new Map();
    const venueUsed = new Set();

    existingPresentations.forEach((p) => {
      p.examiners.forEach((ex) => {
        examinerVenueMap.set(String(ex), String(p.venue));
        venueUsed.add(String(p.venue));
      });
    });

    const allTimeSlots = [
      "08:00","08:30","09:00","09:30","10:00","10:30","11:00","11:30",
      "12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30"
    ];

    const calculateTimeRange = (startTime, durationMins) => {
      const [h, m] = startTime.split(":").map(Number);
      const start = new Date(0, 0, 0, h, m);
      const end   = new Date(start.getTime() + durationMins * 60000);
      const fmt = (n) => String(n).padStart(2, "0");
      return { startTime, endTime: `${fmt(end.getHours())}:${fmt(end.getMinutes())}` };
    };

    const todayString = new Date().toISOString().split("T")[0];
    let currentHHMM = null;
    if (bestDate === todayString) {
      currentHHMM = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    }

    for (const slot of allTimeSlots) {
      if (bestDate === todayString && currentHHMM && slot <= currentHHMM) continue;

      const adjusted = calculateTimeRange(slot, duration);

      const timeOK = await isTimeSlotAvailable(
        bestDate, adjusted.startTime, adjusted.endTime, [], null, studentIds
      );
      if (!timeOK) continue;

      let selectedVenue = null;
      let selectedExaminers = [];

      for (const examiner of departmentExaminers) {
        const mapped = examinerVenueMap.get(String(examiner._id));
        if (mapped) {
          selectedVenue = mapped;
          selectedExaminers.push(examiner);
          if (selectedExaminers.length >= numExaminers) break;
        }
      }

      if (selectedExaminers.length < numExaminers) {
        const newExaminers = departmentExaminers.filter(
          (ex) => !examinerVenueMap.has(String(ex._id))
        );
        if (newExaminers.length >= numExaminers) {
          selectedExaminers = newExaminers.slice(0, numExaminers);
          for (const v of allVenues) {
            if (!venueUsed.has(String(v._id))) {
              selectedVenue = String(v._id);
              venueUsed.add(String(v._id));
              break;
            }
          }
        }
      }

      if (!selectedVenue || selectedExaminers.length < numExaminers) {
        return res.status(400).json({ message: "No suitable venue and examiners available" });
      }

      const venueDetails = await Venue.findById(selectedVenue);
      return res.status(200).json({
        date: bestDate,
        examiners: selectedExaminers,
        venue: venueDetails,
        department,
        timeRange: adjusted,
      });
    }

    return res.status(400).json({ message: "No suitable time slots available" });
  } catch (error) {
    console.error("Error in smartSuggestSlot:", error);
    res.status(500).json({ message: "Server error", error });
  }
};

// ------------------------------
// Smart Suggest (reschedule)
// ------------------------------
export const smartSuggestSlotForReschedule = async (req, res) => {
  try {
    const cleanBody = sanitize(req.body);
    const { error, value } = rescheduleSuggestSchema.validate(cleanBody);
    if (error) return res.status(400).json({ message: error.message });

    const { presentationId } = value;

    const presentation = await Presentation.findById(presentationId)
      .populate("students")
      .populate("examiners");

    if (!presentation) return res.status(404).json({ message: "Presentation not found" });

    const department = presentation.department;
    const duration = presentation.duration;
    const studentIds = presentation.students.map((s) => s._id);

    const examinerDocs = await Examiner.find({
      examiner_id: { $in: presentation.examiners.map((e) => e.examiner_id) },
    });
    const examinerIds = examinerDocs.map((exam) => exam._id);

    const possibleDates = [];
    for (let i = 1; i <= 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      possibleDates.push(d.toISOString().split("T")[0]);
    }

    let bestDate = null;
    let minLectures = Infinity;

    for (const date of possibleDates) {
      let totalLectures = 0;
      for (const examiner of examinerIds) {
        const lecturerSchedule = await Timetable.findOne({
          "weekdays.lecturer": examiner,
          "weekdays.date": date,
        });
        if (lecturerSchedule) totalLectures += lecturerSchedule.weekdays.length;
      }
      if (totalLectures < minLectures) { minLectures = totalLectures; bestDate = date; }
    }

    if (!bestDate) return res.status(400).json({ message: "No suitable new date found" });

    const allVenues = await Venue.find();
    if (!allVenues?.length) return res.status(400).json({ message: "No venues found" });

    const existingRequests = await RescheduleRequest.find({
      "requestedSlot.date": bestDate,
      status: { $ne: "Rejected" },
    });

    const convertToMinutes = (time) => {
      const [hh, mm] = time.split(":").map(Number);
      return hh * 60 + mm;
    };
    const overlaps = (s1, e1, s2, e2) => s1 < e2 && e1 > s2;

    const allTimeSlots = [
      "08:00","08:30","09:00","09:30","10:00","10:30","11:00","11:30",
      "12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30"
    ];

    const calculateTimeRange = (startTime, durationMins) => {
      const [h, m] = startTime.split(":").map(Number);
      const start = new Date(0, 0, 0, h, m);
      const end   = new Date(start.getTime() + durationMins * 60000);
      const fmt = (n) => String(n).padStart(2, "0");
      return { startTime, endTime: `${fmt(end.getHours())}:${fmt(end.getMinutes())}` };
    };

    const todayString = new Date().toISOString().split("T")[0];
    let currentHHMM = null;
    if (bestDate === todayString) {
      currentHHMM = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    }

    for (const slot of allTimeSlots) {
      if (bestDate === todayString && currentHHMM && slot <= currentHHMM) continue;

      const { startTime, endTime } = calculateTimeRange(slot, duration);

      const reqStart = convertToMinutes(startTime);
      const reqEnd   = convertToMinutes(endTime);

      let skip = false;
      for (const r of existingRequests) {
        const s = convertToMinutes(r.requestedSlot.timeRange.startTime);
        const e = convertToMinutes(r.requestedSlot.timeRange.endTime);
        if (overlaps(reqStart, reqEnd, s, e)) { skip = true; break; }
      }
      if (skip) continue;

      const isAvailable = await isTimeSlotAvailable(
        bestDate, startTime, endTime, examinerIds, null, studentIds
      );
      if (!isAvailable) continue;

      // pick first venue
      const chosenVenue = allVenues[0];
      if (!chosenVenue) continue;

      return res.status(200).json({
        date: bestDate,
        examiners: examinerIds,
        venue: chosenVenue,
        department,
        timeRange: { startTime, endTime },
      });
    }

    return res.status(400).json({ message: "No suitable time slots available" });
  } catch (error) {
    console.error("smartSuggestSlotForReschedule error:", error);
    return res.status(500).json({ message: "Server error", error });
  }
};

// ------------------------------
// Requests listing / deletion
// ------------------------------
export const getAllRequests = async (req, res, next) => {
  try {
    const requests = await RescheduleRequest.find()
      .populate({
        path: "presentation",
        populate: [
          { path: "examiners", model: "Examiner" },
          { path: "students",  model: "Student"  },
          { path: "venue",     model: "Venue"    },
        ],
      })
      .populate({
        path: "requestedSlot.venue",
        model: "Venue",
      })
      .populate({
        path: "requestedBy.userId",
        model: "User",
      });

    res.status(200).json(requests);
  } catch (error) {
    next(error);
  }
};

export const deleteRescheduleRequest = async (req, res) => {
  try {
    const requestId = sanitize(req.params.requestId);
    // SECURITY: validate id
    if (!isObjectId(requestId)) return res.status(400).json({ message: "Invalid request ID" });

    const request = await RescheduleRequest.findById(requestId);
    if (!request) return res.status(404).json({ message: "Reschedule request not found" });

    await RescheduleRequest.findByIdAndDelete(requestId);
    res.status(200).json({ message: "Reschedule request deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
};

// ------------------------------
// Fetch by role
// ------------------------------
export const getPresentationsForExaminer = async (req, res) => {
  try {
    const examinerId = sanitize(req.user?.id);
    if (!isObjectId(examinerId)) {
      return res.status(400).json({ message: "Invalid examiner ObjectId" });
    }
    const examinerObjectId = new mongoose.Types.ObjectId(examinerId);

    const presentations = await Presentation.find({ examiners: examinerObjectId });
    if (!presentations.length) {
      return res.status(404).json({ message: "No presentations found for this examiner" });
    }
    res.json(presentations);
  } catch (error) {
    console.error("Error fetching presentations for examiner:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getPresentationsForStudent = async (req, res) => {
  try {
    const studentId = sanitize(req.params.studentId);
    if (!isObjectId(studentId)) {
      return res.status(400).json({ message: "Invalid student ObjectId" });
    }
    const studentObjectId = new mongoose.Types.ObjectId(studentId);

    const presentations = await Presentation.find({ students: studentObjectId });
    if (!presentations.length) {
      return res.status(404).json({ message: "No presentations found for this student" });
    }
    res.json(presentations);
  } catch (error) {
    console.error("Error fetching presentations for student:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getUserPresentations = async (req, res, next) => {
  try {
    const userId = sanitize(req.params.userId);
    if (!userId) return res.status(400).json({ message: "User ID is required" });

    // NOTE: This endpoint uses domain IDs (student_id/examiner_id) via populate-then-filter.
    const userPresentations = await Presentation.find()
      .populate("students", "student_id")
      .populate("examiners", "examiner_id")
      .populate("venue", "venue_id");

    const filtered = userPresentations.filter(
      (p) =>
        p.students.some((s) => s.student_id === userId) ||
        p.examiners.some((e) => e.examiner_id === userId)
    );

    if (!filtered.length) {
      return res.status(404).json({ message: "No presentations found for this user" });
    }
    return res.status(200).json(filtered);
  } catch (error) {
    console.error("Error fetching user presentations:", error);
    return next(error);
  }
};

export const getRescheduleRequestsForExaminer = async (req, res) => {
  try {
    const examinerId = sanitize(req.user?.id);
    if (!examinerId) {
      return res.status(401).json({ message: "Unauthorized request: User not found." });
    }

    const requests = await RescheduleRequest.find({
      "requestedBy.userId": examinerId,
    })
      .populate({
        path: "presentation",
        populate: {
          path: "venue",
          model: "Venue",
          select: "venue_id -_id",
        },
      })
      .sort({ created_at: -1 });

    if (!requests?.length) {
      return res.status(404).json({ message: "No reschedule requests found for this examiner" });
    }

    return res.status(200).json(requests);
  } catch (error) {
    console.error("Error fetching reschedule requests for examiner:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

export const deleteOldRejectedRequests = async (req, res) => {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 2);

    const result = await RescheduleRequest.deleteMany({
      status: "Rejected",
      created_at: { $lt: cutoffDate },
    });

    return res.status(200).json({
      message: `Deleted ${result.deletedCount} old rejected requests.`,
    });
  } catch (error) {
    console.error("Error deleting old rejected requests:", error);
    return res.status(500).json({ message: "Server error", error });
  }
};

export const deleteAllApprovedRequestsForExaminer = async (req, res) => {
  try {
    if (!req.user || !req.user.id || req.user.role !== "examiner") {
      return res.status(401).json({ message: "Unauthorized request: Not an examiner or not logged in." });
    }
    const examinerId = sanitize(req.user.id);

    const result = await RescheduleRequest.deleteMany({
      "requestedBy.userId": examinerId,
      status: "Approved",
    });

    return res.status(200).json({
      message: `All approved requests deleted successfully for examiner ${examinerId}.`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting all approved requests for examiner:", error);
    return res.status(500).json({ message: "Server error", error });
  }
};

export const deleteAllRejectedRequestsForExaminer = async (req, res) => {
  try {
    if (!req.user || !req.user.id || req.user.role !== "examiner") {
      return res.status(401).json({ message: "Unauthorized request: Not an examiner or not logged in." });
    }
    const examinerId = sanitize(req.user.id);

    const result = await RescheduleRequest.deleteMany({
      "requestedBy.userId": examinerId,
      status: "Rejected",
    });

    return res.status(200).json({
      message: `All rejected requests deleted successfully for examiner ${examinerId}.`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error("Error deleting all rejected requests for examiner:", error);
    return res.status(500).json({ message: "Server error", error });
  }
};

export const approveOrRejectReschedule = async (req, res) => {
  try {
    const cleanBody = sanitize(req.body);
    const { requestId, action } = cleanBody;

    if (!isObjectId(requestId)) {
      return res.status(400).json({ message: "Invalid request ID" });
    }
    if (!["Approve", "Reject"].includes(action)) {
      return res.status(400).json({ message: "Action must be Approve or Reject" });
    }

    // 1) Fetch the request & populate the presentation + venue
    const request = await RescheduleRequest.findById(requestId).populate({
      path: "presentation",
      populate: { path: "venue", model: "Venue" },
    });
    if (!request) {
      return res.status(404).json({ message: "Reschedule request not found" });
    }

    const presentation = request.presentation;
    if (!presentation) {
      return res.status(404).json({ message: "Presentation not found in request" });
    }

    const requestorEmail = request.requestorEmail || null;

    // 2) If Reject
    if (action === "Reject") {
      request.status = "Rejected";
      await request.save();

      if (requestorEmail) {
        await sendEmail(
          requestorEmail,
          "Reschedule Request Rejected",
          `Dear Examiner,

Your reschedule request for presentation "${presentation.title}" has been rejected.

Reason:
${request.reason}

If you have questions, please contact the admin.`
        );
      }

      return res.status(200).json({ message: "Reschedule request rejected successfully" });
    }

    // 3) Approve flow
    const { date, timeRange, venue } = request.requestedSlot;
    const { examiners, students, title } = presentation;
    const venueLabel = presentation.venue?.venue_id || "UnknownVenue";

    const isAvailable = await isTimeSlotAvailable(
      date,
      timeRange.startTime,
      timeRange.endTime,
      examiners,
      venue,
      students
    );
    if (!isAvailable) {
      request.status = "Rejected";
      await request.save();

      if (requestorEmail) {
        await sendEmail(
          requestorEmail,
          "Reschedule Request Rejected - Time Slot Unavailable",
          `Dear Examiner,

Your reschedule request for presentation "${title}" was automatically rejected because the requested time slot is not available.

Please contact the admin for further details.`
        );
      }

      return res.status(400).json({
        message: "Time slot is not available. Request automatically rejected.",
      });
    }

    // 4) Update the presentation
    await Presentation.findByIdAndUpdate(presentation._id, {
      date,
      timeRange,
      venue,
    });

    request.status = "Approved";
    await request.save();

    // 5) Email notifications
    if (requestorEmail) {
      await sendEmail(
        requestorEmail,
        "Reschedule Request Approved",
        `Dear Examiner,

Your reschedule request for presentation "${title}" has been approved!

New Date: ${date}
Time: ${timeRange.startTime} - ${timeRange.endTime}
Venue: ${venueLabel}

Thank you.`
      );
    }

    const examinerDocs = await Examiner.find({ _id: { $in: examiners } });
    for (const exDoc of examinerDocs) {
      if (exDoc?.email) {
        await sendEmail(
          exDoc.email,
          "Presentation Rescheduled - Examiner Notification",
          `Dear Examiner,

The presentation "${title}" has been rescheduled.

New Date: ${date}
Time: ${timeRange.startTime} - ${timeRange.endTime}
Venue: ${venueLabel}

Please take note of these changes.`
        );
      }
    }

    const studentDocs = await Student.find({ _id: { $in: students } });
    for (const stDoc of studentDocs) {
      if (stDoc?.email) {
        await sendEmail(
          stDoc.email,
          "Presentation Rescheduled - Student Notification",
          `Dear Student,

Your presentation "${title}" has been rescheduled.

New Date: ${date}
Time: ${timeRange.startTime} - ${timeRange.endTime}
Venue: ${venueLabel}

Please be prepared accordingly.`
        );
      }
    }

    // 6) Reschedule other lectures for examiners
    for (const exDoc of examinerDocs) {
      const fakeReq = { body: { lecturerId: exDoc.examiner_id, date } };
      const fakeRes = { status: () => ({ json: () => {} }) };
      try {
        await rescheduleLectures(fakeReq, fakeRes);
      } catch (err) {
        console.log("Reschedule response for Examiner:", exDoc.examiner_id, response);
      }
    }

    return res.status(200).json({
      message: "Reschedule request approved, presentation updated",
    });
  } catch (error) {
    console.error("Error in approveOrRejectReschedule:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const requestReschedule = async (req, res) => {
  try {
    if (!req.user || !req.user.id || !req.user.role) {
      return res.status(401).json({ message: "Unauthorized request: User not found." });
    }

    const userId = req.user.id;     // from token
    const userType = req.user.role; // e.g. "examiner"

    const cleanBody = sanitize(req.body);
    const { presentationId, date, timeRange, venue, reason, requestorEmail } = cleanBody;

    // Validate IDs
    if (!isObjectId(presentationId)) {
      return res.status(400).json({ message: "Invalid presentation ID" });
    }
    if (!date || !timeRange || !venue) {
      return res.status(400).json({ message: "Date, time range, and venue are required." });
    }
    if (!/^\d{2}:\d{2}$/.test(timeRange.startTime) || !/^\d{2}:\d{2}$/.test(timeRange.endTime)) {
      return res.status(400).json({ message: "Invalid time format. Use HH:MM" });
    }

    // 1) Validate presentation exists
    const presentation = await Presentation.findById(presentationId);
    if (!presentation) {
      return res.status(404).json({ message: "Presentation not found" });
    }

    // 2) Create a new reschedule request
    const newRequest = new RescheduleRequest({
      presentation: presentationId,
      requestedBy: { userId, userType },
      requestorEmail: requestorEmail || "",
      requestedSlot: { date, timeRange, venue },
      reason,
      status: "Pending",
    });

    await newRequest.save();

    return res.status(201).json({
      message: "Reschedule request submitted successfully",
      newRequest,
    });
  } catch (error) {
    console.error("Error in requestReschedule:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};
