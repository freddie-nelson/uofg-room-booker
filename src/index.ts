interface BookingTime {
  date: Date;
  startHour: number;
  endHour: number;
}

class RoomSchedule {
  protected freeTimes: TimeInterval[] = [];

  constructor(readonly date: Date, freeTimes: TimeInterval[] = []) {
    this.addFreeTime(...freeTimes);
  }

  addFreeTime(...times: TimeInterval[]) {
    this.freeTimes.push(...times);
  }

  isFree(time: number): boolean;
  isFree(from: number, to: number): boolean;

  isFree(time: number, to?: number) {
    if (to !== undefined) return this.isFreeInterval(time, to);

    return !!this.freeTimes.find((t) => time >= t.from && time <= t.to);
  }

  protected isFreeInterval(from: number, to: number) {
    return !!this.freeTimes.find((t) => from >= t.from && from <= t.to && to >= t.from && to <= t.to);
  }
}

class Room {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly capacity: number,
    public schedule?: RoomSchedule
  ) {}

  isFree(time: number): boolean;
  isFree(from: number, to: number): boolean;

  isFree(time: number, to?: number) {
    if (!this.schedule) throw new Error("Room has no schedule.");

    return this.schedule.isFree(time, to);
  }
}

class TimeInterval {
  constructor(public from: number, public to: number) {
    if (from >= to) throw new Error("'from' time must be before 'to' time.");
    if (from < 0 || from > 23 || to < 0 || to > 23)
      throw new Error("Times must be between 0 and 23 inclusive.");
  }

  get duration() {
    return this.to - this.from;
  }
}

class UofGRoomBooker {
  protected MAX_BOOKING_DURATION_HOURS = 3;
  protected MAX_BOOKING_DURATION = this.MAX_BOOKING_DURATION_HOURS * 60 * 60 * 1000; // 3 hours in milliseconds
  protected MAX_BOOKING_ADVANCE_DAYS = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
  protected MIN_BOOKING_HOUR = 9;
  protected MAX_BOOKING_HOUR = 22;
  protected BOOKING_TIME_INTERVAL = 0.5;

  protected MIN_ATTENDEES = 1;
  protected MAX_ATTENDEES = 7;

  protected ROOM_LOCATIONS = {
    all: "ALL",
  };

  protected API_URL = "https://frontdoor.spa.gla.ac.uk/timetable";
  protected LOGIN_URL = `${this.API_URL}/login`;
  protected FIND_ROOMS_URL = `${this.API_URL}/bookingv2/findrooms`;
  protected BOOKING_URL = `${this.API_URL}/bookingv2`;

  protected isLoggedIn = false;
  protected cookies = "";

  constructor(protected GUID: string, protected PASSWORD: string) {}

  async login() {
    if (this.isLoggedIn) throw new Error("Already logged in.");

    const res = await this.post(this.LOGIN_URL, {
      guid: this.GUID,
      password: this.PASSWORD,
      rememberMe: false,
    });

    const json = await res.json();
    if (json.error) throw new Error(json.error);

    // store auth / session id cookies
    this.cookies = res.headers.get("set-cookie");

    this.isLoggedIn = true;
  }

  /**
   * Finds rooms that match the given parameters.
   *
   * @param attendees The number of attendees
   * @param time A {@link BookingTime} object representing the time to book the room for
   *
   * @returns An array of {@link Room} objects, representing the available rooms found
   */
  async findRooms(attendees: number, time: BookingTime) {
    this.validateAttendees(attendees);
    this.validateBookingTime(time);

    const { date, startHour, endHour } = time;

    const startDate = new Date(date.getTime() + startHour * 60 * 60 * 1000);
    const endDate = new Date(date.getTime() + endHour * 60 * 60 * 1000);

    const res = await this.post(this.FIND_ROOMS_URL, {
      attendees: attendees.toString(),
      bookingDate: `${date.getDate()} ${date.toDateString().split(" ")[1]} ${date.getFullYear()}`,
      startTime: `${startDate.getHours().toString().padStart(2, "0")}:${startDate
        .getMinutes()
        .toString()
        .padStart(2, "0")}`,
      endTime: `${endDate.getHours().toString().padStart(2, "0")}:${endDate
        .getMinutes()
        .toString()
        .padStart(2, "0")}`,
      location: this.ROOM_LOCATIONS.all,
    });

    return this.formatFindRoomsResponse(await res.json());
  }

  /**
   * Books a room.
   *
   * @param roomId The id of the room to book
   * @param attendees The number of attendees
   * @param time The time to book the room
   *
   * @returns `true` if the booking is successful, throws otherwise
   */
  async bookRoom(roomId: Room["id"], attendees: number, time: BookingTime) {
    this.validateAttendees(attendees);
    this.validateBookingTime(time);

    const duration = time.endHour - time.startHour;

    // create date increments for every half hour interval between startHour (inclusive) and endHour (exclusive)
    const dates = [];
    for (let i = 0; i < duration; i += 0.5) {
      const curr = new Date(time.date.getTime() + time.startHour * 60 * 60 * 1000 + i * 60 * 60 * 1000);
      dates.push(
        // creates dates that look like "2022-12-19 09:00"
        `${curr.toLocaleDateString().split("/").reverse().join("-")} ${curr
          .getHours()
          .toString()
          .padStart(2, "0")}:${curr.getMinutes().toString().padStart(2, "0")}`
      );
    }

    const res = await this.post(this.BOOKING_URL, {
      attendees: attendees.toString(),
      dates,
      locationId: roomId,
    });

    return true;
  }

  /**
   * Books rooms so throughout the day a room will always be booked, based on rooms current schedules.
   *
   * @param rooms The rooms that can be booked (must have schedules)
   * @param attendees The number of attendees to book for
   */
  async bookRoomsForDay(rooms: Room[], attendees: number) {
    this.validateAttendees(attendees);

    if (rooms.find((r) => !r.schedule)) throw new Error("A room provided does not have a schedule.");
    if (rooms.find((r) => r.schedule.date.getTime() !== rooms[0].schedule.date.getTime()))
      throw new Error("Every room must have a schedule from the same day.");

    const validRooms = rooms.filter((r) => r.capacity >= attendees);

    let currentHour = this.MIN_BOOKING_HOUR;
    let currentDuration = this.MAX_BOOKING_DURATION_HOURS;
    let bookedTo = 0;

    let roomsToBook: { room: Room; time: BookingTime }[] = [];

    while (bookedTo !== this.MAX_BOOKING_HOUR) {
      let currentEndHour = currentHour + currentDuration;

      const freeRoomIndex = validRooms.findIndex((r) => r.isFree(currentHour, currentEndHour));
      const freeRoom = validRooms[freeRoomIndex];
      if (!freeRoom) {
        // no free room found so try to book for smaller duration
        currentDuration -= this.BOOKING_TIME_INTERVAL;

        // if booking duration reaches 0 then no room exists which is free at this time
        if (currentDuration === 0) break;
        else continue;
      }

      roomsToBook.push({
        room: freeRoom,
        time: {
          date: freeRoom.schedule.date,
          startHour: currentHour,
          endHour: currentEndHour,
        },
      });
      validRooms.splice(freeRoomIndex, 1);

      bookedTo = currentEndHour;
      currentHour += currentDuration;

      // reset current duration but make sure currentHour + currentDuration will not exceed the MAX_BOOKING_HOUR
      currentDuration = Math.min(this.MAX_BOOKING_HOUR - currentHour, this.MAX_BOOKING_DURATION_HOURS);
    }

    const bookedRooms = await Promise.allSettled(
      roomsToBook.map(async (r) => {
        await this.bookRoom(r.room.id, attendees, r.time);
        return r;
      })
    ).then((res) => res.map((v) => (v.status === "fulfilled" ? v.value : v)));

    return bookedRooms;
  }

  /**
   * Finds all free rooms and their schedules for a given day.
   *
   * @param attendees The number of attendees
   * @param date The booking date
   * @returns An array of {@link Room} objects with their `schedule` field set to the found room schedule
   */
  async findRoomsWithSchedules(attendees: number, date: BookingTime["date"]) {
    this.validateAttendees(attendees);
    this.validateBookingTime({ date, startHour: this.MIN_BOOKING_HOUR, endHour: this.MIN_BOOKING_HOUR + 1 });

    // find rooms available at every half hour interval of the given day
    const schedule: { [index: number]: Promise<Room[]> } = {};

    for (let i = this.MIN_BOOKING_HOUR; i < this.MAX_BOOKING_HOUR; i += 0.5) {
      schedule[i] = this.findRooms(attendees, { date, startHour: i, endHour: i + 0.5 });
    }

    await Promise.allSettled(Object.values(schedule));

    // get the times at which each individual room is free throughout the day
    const roomFreeTimes: { [index: Room["id"]]: number[] } = {};
    const foundRooms: { [index: Room["id"]]: Room } = {};

    for (const [time, rooms] of Object.entries(schedule).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      for (const room of await rooms) {
        if (!roomFreeTimes[room.id]) {
          roomFreeTimes[room.id] = [];
          foundRooms[room.id] = room;
        }

        roomFreeTimes[room.id].push(Number(time));
      }
    }

    // format into RoomSchedule objects
    for (const [roomId, times] of Object.entries(roomFreeTimes)) {
      const schedule = new RoomSchedule(date);

      let start = times[0];

      for (let i = 1; i <= times.length; i++) {
        const last = times[i - 1];
        const time = times[i];

        // if there is a gap bigger than half an hour between times then
        // the room must be booked between these times
        // also add the time slot if we reach the end of the times array (time === undefined)
        if (time - last !== 0.5 || time === undefined) {
          schedule.addFreeTime({
            from: start,
            to: last + 0.5,
            duration: last + 0.5 - start,
          });

          start = time;
        }
      }

      foundRooms[roomId].schedule = schedule;
    }

    return Object.values(foundRooms);
  }

  protected validateBookingTime({ date, startHour, endHour }: BookingTime) {
    // make sure startHour and endHour are either ints or .5 intervals
    const flooredStartHour = Math.floor(startHour);
    const flooredEndHour = Math.floor(endHour);

    if (
      (startHour !== flooredStartHour && startHour - flooredStartHour !== 0.5) ||
      (endHour !== flooredEndHour && endHour - flooredEndHour !== 0.5)
    )
      throw new Error(
        "Start and end hours must integers or floats with .5 as the decimal part (half hour intervals)."
      );

    // round date to start of day
    date.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const now = new Date();

    // validate date
    if (
      date.getTime() < today.getTime() ||
      (date.getTime() === today.getTime() && now.getHours() >= startHour)
    )
      throw new Error("Date cannot be in the past.");
    if (date.getTime() > today.getTime() + this.MAX_BOOKING_ADVANCE_DAYS)
      throw new Error("Date cannot be more than 7 days in the future.");

    // validate start and end times
    const duration = endHour - startHour;
    if (duration <= 0) throw new Error("Start time must be before end time.");
    if (duration > this.MAX_BOOKING_DURATION) throw new Error("Room cannot be booked for more than 3 hours.");

    if (
      startHour < this.MIN_BOOKING_HOUR ||
      endHour < this.MIN_BOOKING_HOUR ||
      startHour > this.MAX_BOOKING_HOUR ||
      endHour > this.MAX_BOOKING_HOUR
    )
      throw new Error(
        `Start and end times must be between ${this.MIN_BOOKING_HOUR.toString().padStart(
          2,
          "0"
        )}:00 and ${this.MAX_BOOKING_HOUR.toString().padStart(2, "0")}:00 inclusive.`
      );
  }

  protected validateAttendees(attendees: number) {
    if (attendees < this.MIN_ATTENDEES || attendees > this.MAX_ATTENDEES)
      throw new Error("Capacity must be between ${this.MIN_ATTENDEES} and ${this.MAX_ATTENDEES}.");
  }

  protected formatFindRoomsResponse(raw: any[][]): Room[] {
    return raw.map((rawRoom) => {
      return new Room(rawRoom[0], rawRoom[1], rawRoom[2]);
    });
  }

  protected get(url: string) {
    return fetch(url, {
      method: "GET",
    });
  }

  protected async post(url: string, body?: { [index: string]: any }) {
    const headers = new Headers();
    headers.append("Content-Type", "application/json");
    headers.append("Cookie", this.cookies);

    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
      credentials: "include",
    });

    if (res.headers.get("Content-Type") === "application/json") {
      const json = await res.clone().json();
      if (json.error) throw new Error(json.error);
    }

    return res;
  }
}

(async () => {
  const booker = new UofGRoomBooker("2768903N", "rhq9PopQezkpCZ");

  const attendees = 4;
  const time: BookingTime = {
    date: new Date("22 Dec 2022"),
    startHour: 9,
    endHour: 12,
  };

  await booker.login();

  const rooms = await booker.findRoomsWithSchedules(attendees, time.date);
  console.log(rooms);

  const roomsToBook = await booker.bookRoomsForDay(rooms, attendees);
  console.log(roomsToBook);

  // const availableRooms = await booker.findRooms(attendees, time);
  // console.log(availableRooms);

  // const isBooked = await booker.bookRoom(availableRooms[0].id, attendees, time);

  // console.log("Successfully booked?", isBooked);
})();
