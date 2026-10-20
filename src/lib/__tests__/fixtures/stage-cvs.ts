/**
 * Synthetic CVs for the stage-calibration eval.
 *
 * These are Grade 12 applicants, so none of them has an internship, a
 * publication or a degree. The strong one should be judged excellent *for a
 * high schooler*; the weak one has no evidence at all. They live under
 * `__tests__` only — nothing here is imported by production code, and the
 * expected score bands are in the eval test, never in the prompt.
 */

export const STRONG_GRADE_12_CV = `SARA AL-HADDAD
Amman, Jordan | sara.haddad@example.com

Objective
Computer Science (BSc) — robotics and embedded systems.

Education
Grade 12 — Al Noor Secondary School, Amman (2024–2026)
GPA 94/100. Coursework: mathematics, physics, computer science.

Projects
Line-Following Robot — team lead (3 students)
- Led the design of a four-sensor PID robot that completed a 12 m track in 8.4 seconds, finishing 2nd of 19 teams at school robotics day.
- Wrote the control loop in Arduino C++ and cut overshoot by tuning the derivative term after 30 test runs.

School Water-Use Tracker — solo project
- Built a Google Sheets and Apps Script tracker used by 6 classrooms; recorded 18% lower water use over one month.

Leadership and activities
Founder, Robotics Club (2025–present) — grew the club from 3 to 21 members and ran 6 weekly workshops.
Participant, Jordan National Informatics Olympiad 2026 — solved 3 of 4 problems in the qualifying round with a clear role on the team.
Volunteer mathematics tutor — 20 sessions for Grade 9 students.

Skills
Arduino, C++, Python (intermediate), Google Apps Script, basic CAD (Fusion 360).

Certificate
CS50x, edX (2025).
`;

export const MEDIUM_GRADE_12_CV = `Omar Nasser
Amman, Jordan | omar.nasser@example.com

Objective
To study Computer Science abroad.

Education
Grade 12 — Al Noor Secondary School (expected 2026)
GPA 88/100.

Experience
Member of the school computer club; attended weekly meetings and helped set up laptops for events.
Helped organise the annual school science fair.

Projects
Personal portfolio website built with HTML and CSS.
Simple calculator written in Python.

Skills
Microsoft Office, Python basics, teamwork, communication.

Languages
Arabic (native), English (good).
`;

export const WEAK_GRADE_12_CV = `Ahmad
I am a student who likes computers and wants to study abroad.

Education: high school.

I have good skills in Microsoft Word and the internet.
I am hardworking, motivated, and a team player.
I want to improve my English and get a scholarship.

Hobbies: football, reading.
`;
