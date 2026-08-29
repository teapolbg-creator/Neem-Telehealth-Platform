// Static mock data for Neem prototype screens
import doctorAma from "@/assets/doctor-ama.jpg";
import doctorKwame from "@/assets/doctor-kwame.jpg";

export const doctors = [
  {
    id: "d1",
    name: "Dr. Ama Boateng",
    mdc: "MDC-44291-GH",
    specialty: "General Practice & Infectious Diseases",
    languages: ["English", "Twi", "Ga"],
    rating: 4.9,
    photo: doctorAma,
    status: "online" as const,
    consultationsToday: 14,
    weeklyHours: 32,
  },
  {
    id: "d2",
    name: "Dr. Kwame Owusu",
    mdc: "MDC-88291-GH",
    specialty: "General Practitioner",
    languages: ["English", "Twi", "Ewe"],
    rating: 4.8,
    photo: doctorKwame,
    status: "online" as const,
    consultationsToday: 11,
    weeklyHours: 28,
  },
];

export type SessionStatus =
  | "waiting_payment"
  | "waiting"
  | "joined"
  | "assigned"
  | "live"
  | "completed";

export const todaySessions = [
  { id: "NM-99281", patient: "Efua M.", ageRange: "30–40", gender: "F", status: "live" as SessionStatus, doctor: "Dr. Ama Boateng", duration: "12:04" },
  { id: "NM-99280", patient: "Kofi A.", ageRange: "40–50", gender: "M", status: "waiting_payment" as SessionStatus, doctor: "—", duration: "—" },
  { id: "NM-99279", patient: "Akosua S.", ageRange: "20–30", gender: "F", status: "completed" as SessionStatus, doctor: "Dr. Kwame Owusu", duration: "18:22" },
  { id: "NM-99278", patient: "Yaw B.", ageRange: "50–60", gender: "M", status: "completed" as SessionStatus, doctor: "Dr. Ama Boateng", duration: "09:41" },
  { id: "NM-99277", patient: "Adjoa D.", ageRange: "30–40", gender: "F", status: "completed" as SessionStatus, doctor: "Dr. Kwame Owusu", duration: "22:10" },
];

export const pharmacies = [
  { id: "p1", name: "Akosua Pharmacy, Adabraka", city: "Accra", status: "active", consultations: 214, revenue: 12480 },
  { id: "p2", name: "HealthFirst, East Legon", city: "Accra", status: "active", consultations: 189, revenue: 10920 },
  { id: "p3", name: "Kumasi Central Chemist", city: "Kumasi", status: "active", consultations: 156, revenue: 8940 },
  { id: "p4", name: "Tamale Care Pharmacy", city: "Tamale", status: "pending", consultations: 0, revenue: 0 },
];

export const languages = [
  { code: "en", label: "English", sub: "Default" },
  { code: "tw", label: "Twi", sub: "Akan" },
  { code: "ga", label: "Ga", sub: "Greater Accra" },
  { code: "ee", label: "Ewe", sub: "Volta" },
  { code: "dag", label: "Dagbani", sub: "Northern" },
  { code: "ha", label: "Hausa", sub: "Northern" },
];

export const statusMeta: Record<SessionStatus, { label: string; tone: "brand" | "medical" | "warning" | "muted" }> = {
  waiting_payment: { label: "Awaiting Payment", tone: "warning" },
  waiting: { label: "Waiting", tone: "muted" },
  joined: { label: "Patient Joined", tone: "medical" },
  assigned: { label: "Doctor Assigned", tone: "medical" },
  live: { label: "Live", tone: "brand" },
  completed: { label: "Completed", tone: "muted" },
};
