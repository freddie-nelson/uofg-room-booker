interface Room {
  id: string;
  name: string;
  capacity: number;
}

interface BookingTime {
  date: Date;
  startHour: number;
  endHour: number;
}

class UofGRoomBooker {
  protected MAX_BOOKING_DURATION = 3 * 60 * 60 * 1000; // 3 hours in milliseconds
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

    const res = await this.post(this.FIND_ROOMS_URL, {
      attendees: attendees.toString(),
      bookingDate: `${date.getDate()} ${date.toDateString().split(" ")[1]} ${date.getFullYear()}`,
      startTime: `${startHour.toString().padStart(2, "0")}:00`,
      endTime: `${endHour.toString().padStart(2, "0")}:00`,
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
    for (let i = 0; i < duration * 2; i++) {
      const curr = new Date(time.date.getTime() + time.startHour * 60 * 60 * 1000 + i * 30 * 60 * 1000);
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

  protected validateBookingTime({ date, startHour, endHour }: BookingTime) {
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
    if (date.getTime() > today.getTime() + 7 * 24 * 60 * 60 * 1000)
      throw new Error("Date cannot be more than 7 days in the future.");

    // validate start and end times
    const duration = endHour - startHour;
    if (duration <= 0) throw new Error("Start time must be before end time.");
    if (duration > this.MAX_BOOKING_DURATION) throw new Error("Room cannot be booked for more than 3 hours.");

    if (startHour < 9 || endHour < 9 || startHour > 22 || endHour > 22)
      throw new Error("Start and end times must be between 9am and 10pm inclusive.");
  }

  protected validateAttendees(attendees: number) {
    if (attendees < 1 || attendees > 7) throw new Error("Capacity must be between 1 and 7.");
  }

  protected formatFindRoomsResponse(raw: any[][]): Room[] {
    return raw.map((rawRoom) => {
      return <Room>{
        id: rawRoom[0],
        name: rawRoom[1],
        capacity: rawRoom[2],
      };
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
    date: new Date("20 Dec 2022"),
    startHour: 9,
    endHour: 12,
  };

  await booker.login();

  const availableRooms = await booker.findRooms(attendees, time);
  console.log(availableRooms);

  const isBooked = await booker.bookRoom(availableRooms[0].id, attendees, time);

  console.log("Successfully booked?", isBooked);
})();
