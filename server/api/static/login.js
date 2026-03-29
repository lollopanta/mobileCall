async function handleLogin(event) {
	event.preventDefault();

	const uName = document.querySelector('#username').value;
	const passW = document.querySelector('#user_password').value;

	if (uName.length <= 5) {
        console.log("Username too short, username must be more than 5 characters");
        return;
    }

    if (passW.length <= 6) {
    	console.log("Password too short, password must be more than 6 characters");
    	return;
	}

	const dataToSend = {
		username: uName,
		password: passW
	};

	try {
		const response = await fetch('/login', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(dataToSend)
		});

		const result = await response.json();
		console.log("Server response:", result);

		if (result.status === "successful") {
			console.log("Login successful, storing token...");
            localStorage.setItem('auth_token', result.token);
            localStorage.setItem('user_data', JSON.stringify(result.user));
			window.location.href = `/user/${uName}`; 
		} else {
			console.log("Login unsuccessful:", result.message);
		}
	} catch (error) {
		console.log("Network error:", error);
	}
}

const loginForm = document.querySelector('#loginForm');
if (loginForm) {
	loginForm.addEventListener('submit', handleLogin);
}