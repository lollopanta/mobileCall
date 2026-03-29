async function handleRegistration(event) {
    event.preventDefault(); 

    const uName = document.querySelector('#username').value;
    const pass = document.querySelector('#user_password').value;
    const confirmPass = document.querySelector('#confirm_user_password').value;

    if (uName.length <= 5) {
        console.log("Username too short, username must be more than 5 characters");
        return;
    }
    
    if (pass.length <= 6) {
        console.log("Password too short, password must be more than 6 characters");
        return;
    }

    if (pass !== confirmPass) {
        console.log("Passwords do not match!");
        return; 
    } 

    const dataToSend = {
        username: uName,
        password: pass
    };

    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify(dataToSend) 
        });

        const result = await response.json();
        console.log("Server response:", result);

        if (result.status === "successful") {
            console.log("Registration successful, storing token...");
            localStorage.setItem('auth_token', result.token);
            window.location.href = "/login";
        } else {
            console.log("Registration unsuccessful:", result.message);
        }
    } catch (error) {
        console.error("Network error:", error);
    }
}

const registerForm = document.querySelector('#registerForm');
if (registerForm) {
    registerForm.addEventListener('submit', handleRegistration);
}
