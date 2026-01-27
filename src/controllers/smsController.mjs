import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

export const sendCustomerMessage = async (req, res) => {
    console.log("sending message")
    const { messageTo, messageFrom, message } = req.body;
    const data = {
        "sender": messageFrom,
        "message": message,
        "recipients": [messageTo],
      };

        const config = {
        method: 'post',
        url: 'https://sms.arkesel.com/api/v2/sms/send',
        headers: {
        'api-key': process.env.ARKESEL_SMS_API_KEY
        },
        data : data
        };

    axios(config)
    .then(function (response) {
    console.log(JSON.stringify(response.data));
    res.status(200).json(response.data)
    })
    .catch(function (error) {
    console.log(error);
  });
}


export const sendCustomerMessageBackend = async (messageTo, messageFrom, message) => {
    console.log("sending message")
    const data = {
        "sender": messageFrom,
        "message": message,
        "recipients": [messageTo],
      };

        const config = {
        method: 'post',
        url: 'https://sms.arkesel.com/api/v2/sms/send',
        headers: {
        'api-key': process.env.ARKESEL_SMS_API_KEY
        },
        data : data
        };

    axios(config)
    .then(function (response) {
    console.log(JSON.stringify(response.data));
    res.status(200).json(response.data)
    })
    .catch(function (error) {
    console.log(error);
  });
}