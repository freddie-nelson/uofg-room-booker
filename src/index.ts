class UofGRoomBooker {
  protected API_URL = "https://frontdoor.spa.gla.ac.uk/timetable";
  protected LOGIN_URL = `${this.API_URL}/login`;

  protected isLoggedIn = false;

  constructor(protected GUID: string, protected PASSWORD: string) {}

  async login() {
    const res = await this.post(this.LOGIN_URL, {
      guid: this.GUID,
      password: this.PASSWORD,
      rememberMe: false,
    });
    console.log(res);

    this.isLoggedIn = true;
  }

  protected get(url: string) {
    return fetch(url, {
      method: "GET",
    });
  }

  protected post(url: string, body?: { [index: string]: any }) {
    return fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

const booker = new UofGRoomBooker("2768903N", "rhq9PopQezkpCZ");
booker.login();
